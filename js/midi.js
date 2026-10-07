/*
 * MIDI 解析与 MusicXML 生成 —— 由 Android 端 MidiToMusicXml.kt 逐行移植。
 *
 * alphaTab 只能读取 Guitar Pro / MusicXML / Capella / alphaTex，没有 Standard MIDI
 * File 导入器，所以 MIDI 乐谱必须先翻译成 MusicXML 再交给 viewer 渲染。
 *
 * 转换策略与原生端保持一致：所有音符轨合并成一个钢琴声部，让 viewer 显示一行
 * 大谱表（高音 + 低音）而不是多行分谱；音符在小节线处截断并以延音线跨小节连接；
 * 小节内互相重叠的音符分配到多个声部，避免持续和弦塌陷到一条流动的旋律上。
 */
(function (global) {
    'use strict';

    var FALLBACK_DIVISION = 480;
    var EPSILON = 0.02;
    var SPLIT_PITCH = 60;

    function MidiConversionException(message) {
        this.name = 'MidiConversionException';
        this.message = message;
    }
    MidiConversionException.prototype = Object.create(Error.prototype);

    /* ------------------------------------------------------------------ */
    /* 解析模型                                                            */
    /* ------------------------------------------------------------------ */

    function TimedValue(tick, value) {
        this.tick = tick;
        this.value = value;
    }

    function TimeSignature(numerator, denominator) {
        this.numerator = numerator;
        this.denominator = denominator;
    }

    Object.defineProperty(TimeSignature.prototype, 'quarterLength', {
        get: function () { return this.numerator * (4.0 / this.denominator); }
    });

    function MidiNote(startTick, endTick, pitch) {
        this.startTick = startTick;
        this.endTick = endTick;
        this.pitch = pitch;
    }

    function MidiTrack(name, notes) {
        this.name = name;
        this.notes = notes;
    }

    function MidiFile(division, tracks, timeSignatures, keySignatures, tempos) {
        this.division = division;
        this.tracks = tracks;
        this.timeSignatures = timeSignatures;
        this.keySignatures = keySignatures;
        this.tempos = tempos;
    }

    /* ------------------------------------------------------------------ */
    /* 解析器                                                              */
    /* ------------------------------------------------------------------ */

    function Cursor(data) {
        this.data = data;
        this.pos = 0;
    }

    Cursor.prototype.u8 = function () {
        if (this.pos >= this.data.length) throw new MidiConversionException('MIDI 文件意外结束');
        return this.data[this.pos++] & 0xFF;
    };

    Cursor.prototype.u16 = function () { return (this.u8() << 8) | this.u8(); };

    Cursor.prototype.u32 = function () {
        return (((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0);
    };

    Cursor.prototype.ascii = function (length) {
        if (this.pos + length > this.data.length) throw new MidiConversionException('MIDI 文件意外结束');
        var text = asciiOf(this.data, this.pos, length);
        this.pos += length;
        return text;
    };

    Cursor.prototype.peekAscii = function (length) {
        if (this.pos + length > this.data.length) return '';
        return asciiOf(this.data, this.pos, length);
    };

    Cursor.prototype.varLen = function () {
        var value = 0;
        var byte;
        var guard = 0;
        do {
            byte = this.u8();
            value = (value << 7) | (byte & 0x7F);
            guard++;
        } while ((byte & 0x80) !== 0 && guard < 5);
        return value;
    };

    Cursor.prototype.skip = function (count) { this.pos += count; };

    function asciiOf(data, offset, length) {
        var out = '';
        for (var i = 0; i < length; i++) out += String.fromCharCode(data[offset + i]);
        return out;
    }

    function utf8Of(data, offset, length) {
        var clamped = Math.min(length, data.length - offset);
        if (clamped <= 0) return '';
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(data.subarray(offset, offset + clamped));
        }
        var out = '';
        for (var i = 0; i < clamped; i++) out += String.fromCharCode(data[offset + i]);
        return out;
    }

    function RawNoteEvent(tick, isOn, key, pitch) {
        this.tick = tick;
        this.isOn = isOn;
        this.key = key;
        this.pitch = pitch;
    }

    function readMidi(bytes) {
        if (bytes.length < 14) throw new MidiConversionException('MIDI 文件过短');
        var cursor = new Cursor(bytes);

        if (cursor.ascii(4) !== 'MThd') throw new MidiConversionException('不是有效的 MIDI 文件（缺少 MThd）');
        var headerLength = cursor.u32();
        cursor.u16();
        var declaredTracks = cursor.u16();
        var divisionRaw = cursor.u16();
        cursor.skip(Math.max(headerLength - 6, 0));

        var division = ((divisionRaw & 0x8000) !== 0 || divisionRaw === 0)
            ? FALLBACK_DIVISION
            : divisionRaw;

        var tracks = [];
        var timeSignatures = [];
        var keySignatures = [];
        var tempos = [];

        // 头部里的轨道数在实际文件中并不可靠（简易导出器写出的数量常常与实际
        // 存在的 chunk 不符），所以以 chunk 本身为准。
        var parsed = 0;
        var limit = Math.max(declaredTracks, 1) + 64;
        while (parsed < limit && cursor.pos + 8 <= bytes.length && cursor.peekAscii(4) === 'MTrk') {
            cursor.skip(4);
            var trackLength = cursor.u32();
            var trackEnd = Math.min(cursor.pos + trackLength, bytes.length);

            tracks.push(readTrack(cursor, trackEnd, timeSignatures, keySignatures, tempos));
            cursor.pos = trackEnd;
            parsed++;
        }

        var anyNotes = false;
        for (var i = 0; i < tracks.length; i++) {
            if (tracks[i].notes.length > 0) { anyNotes = true; break; }
        }
        if (!anyNotes) throw new MidiConversionException('MIDI 文件中没有可显示的音符');

        return new MidiFile(
            division,
            tracks,
            timeSignatures.slice().sort(byTick),
            keySignatures.slice().sort(byTick),
            tempos.slice().sort(byTick)
        );
    }

    function byTick(a, b) { return a.tick - b.tick; }

    function readTrack(cursor, trackEnd, timeSignatures, keySignatures, tempos) {
        var notes = [];
        var pending = new Map();
        var rawNotes = [];
        var tick = 0;
        var runningStatus = 0;
        var name = null;
        var data = cursor.data;

        while (cursor.pos < trackEnd) {
            tick += cursor.varLen();
            if (cursor.pos >= trackEnd) break;

            var status = data[cursor.pos] & 0xFF;
            if (status < 0x80) {
                if (runningStatus === 0) throw new MidiConversionException('MIDI 事件缺少状态字节');
                status = runningStatus;
            } else {
                cursor.pos++;
                if (status < 0xF0) runningStatus = status;
            }

            if (status === 0xFF) {
                var type = cursor.u8();
                var length = cursor.varLen();
                var payloadStart = cursor.pos;
                if (type === 0x51) {
                    if (length >= 3) {
                        var micros = ((data[payloadStart] & 0xFF) << 16) |
                            ((data[payloadStart + 1] & 0xFF) << 8) |
                            (data[payloadStart + 2] & 0xFF);
                        if (micros > 0) tempos.push(new TimedValue(tick, micros));
                    }
                } else if (type === 0x58) {
                    if (length >= 2) {
                        var numerator = data[payloadStart] & 0xFF;
                        var denominator = 1 << (data[payloadStart + 1] & 0xFF);
                        if (numerator > 0) {
                            timeSignatures.push(new TimedValue(tick, new TimeSignature(numerator, denominator)));
                        }
                    }
                } else if (type === 0x59) {
                    if (length >= 1) {
                        // 有符号字节：fifths 为负表示降号调。
                        var fifths = (data[payloadStart] << 24) >> 24;
                        keySignatures.push(new TimedValue(tick, fifths));
                    }
                } else if (type === 0x03) {
                    var decoded = utf8Of(data, payloadStart, length).trim();
                    name = decoded.length > 0 ? decoded : null;
                } else if (type === 0x2F) {
                    cursor.pos = trackEnd;
                    break;
                }
                cursor.pos = payloadStart + length;
            } else if (status === 0xF0 || status === 0xF7) {
                var sysexLength = cursor.varLen();
                cursor.skip(sysexLength);
            } else {
                var high = status & 0xF0;
                var channel = status & 0x0F;
                if (high === 0x90) {
                    var onPitch = cursor.u8();
                    var velocity = cursor.u8();
                    rawNotes.push(new RawNoteEvent(tick, velocity > 0, (channel << 8) | onPitch, onPitch));
                } else if (high === 0x80) {
                    var offPitch = cursor.u8();
                    cursor.u8();
                    rawNotes.push(new RawNoteEvent(tick, false, (channel << 8) | offPitch, offPitch));
                } else if (high === 0xA0 || high === 0xB0 || high === 0xE0) {
                    cursor.skip(2);
                } else if (high === 0xC0 || high === 0xD0) {
                    cursor.skip(1);
                } else {
                    cursor.skip(1);
                }
            }
        }

        // 同一 tick 上的 note-off 先于 note-on 处理：把重复音写成 "on, off" 的导出器
        // 否则会得到一个零长度音符，并吞掉紧随其后的那个音。
        rawNotes.sort(function (a, b) {
            if (a.tick !== b.tick) return a.tick - b.tick;
            return (a.isOn ? 1 : 0) - (b.isOn ? 1 : 0);
        });
        for (var i = 0; i < rawNotes.length; i++) {
            var event = rawNotes[i];
            closeNote(notes, pending, event.key, event.pitch, event.tick);
            if (event.isOn) pending.set(event.key, event.tick);
        }

        // 省略末尾 note-off 的文件否则会丢掉最后几个音。
        pending.forEach(function (start, key) {
            if (tick > start) notes.push(new MidiNote(start, tick, key & 0xFF));
        });

        return new MidiTrack(name, notes);
    }

    function closeNote(notes, pending, key, pitch, tick) {
        if (!pending.has(key)) return;
        var start = pending.get(key);
        pending.delete(key);
        if (tick > start) notes.push(new MidiNote(start, tick, pitch));
    }

    /* ------------------------------------------------------------------ */
    /* MusicXML 生成器                                                     */
    /* ------------------------------------------------------------------ */

    function Bar(index, start, end, timeSignature) {
        this.index = index;
        this.start = start;
        this.end = end;
        this.timeSignature = timeSignature;
    }

    function Chord(start, end, pitches) {
        this.start = start;
        this.end = end;
        this.pitches = pitches;
    }

    function ChordSegment(start, end, pitches, tieStart, tieStop) {
        this.start = start;
        this.end = end;
        this.pitches = pitches;
        this.tieStart = tieStart;
        this.tieStop = tieStop;
    }

    function StaffedNote(note, staff) {
        this.note = note;
        this.staff = staff;
    }

    var STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
    var ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

    function MusicXmlBuilder(midi) {
        this.midi = midi;
        this.division = midi.division;
        // 录制出来的 MIDI 节奏几乎不精确（音符被缩短成断奏），直接使用会产生无法记谱的
        // 时值。起止都吸附到十六分音符网格，结果才读起来像真正的乐谱而不是任意连音符。
        this.gridTicks = Math.max(1, Math.floor(this.division / 4));
        this.bars = this.buildBars();
        this.noteTracks = midi.tracks.filter(function (track) { return track.notes.length > 0; });
        this.splitByTrack = this.noteTracks.length === 2;
        this.staffCount = this.splitByTrack
            ? 2
            : (this.hasChordsAcrossMiddleC() ? 2 : 1);
        this.trackStaff = this.buildTrackStaff();
        this.staffedNotes = this.buildStaffedNotes();
        this.title = null;
        for (var i = 0; i < midi.tracks.length; i++) {
            if (midi.tracks[i].name) { this.title = midi.tracks[i].name; break; }
        }
        this.out = [];
    }

    MusicXmlBuilder.prototype.build = function () {
        this.out.length = 0;
        this.push('<?xml version="1.0" encoding="UTF-8"?>\n');
        this.push('<score-partwise version="3.1">\n');
        this.push('  <identification>\n');
        this.push('    <encoding><software>PianoScoreFollower</software></encoding>\n');
        this.push('  </identification>\n');
        if (this.title) {
            this.push('  <movement-title>' + escapeXml(this.title) + '</movement-title>\n');
        }
        this.push('  <part-list>\n');
        this.push('    <score-part id="P1"><part-name>Piano</part-name></score-part>\n');
        this.push('  </part-list>\n');
        this.writePart();
        this.push('</score-partwise>\n');
        return this.out.join('');
    };

    MusicXmlBuilder.prototype.push = function (text) { this.out.push(text); };

    MusicXmlBuilder.prototype.writePart = function () {
        var segments = this.distributeToBars();
        var previousKey = null;
        var previousTime = null;
        var staffed = this.staffedNotes;
        var sum = 0;
        for (var i = 0; i < staffed.length; i++) sum += staffed[i].note.pitch;
        var singleStaffIsBass = this.staffCount === 1 &&
            (sum / Math.max(staffed.length, 1)) < SPLIT_PITCH;

        this.push('  <part id="P1">\n');

        for (var barIndex = 0; barIndex < this.bars.length; barIndex++) {
            var bar = this.bars[barIndex];
            this.push('    <measure number="' + (barIndex + 1) + '">\n');

            var activeTime = this.timeSignatureAt(bar.start);
            var activeKey = this.keySignatureAt(bar.start);
            var needsAttributes = barIndex === 0 ||
                activeTime !== previousTime ||
                activeKey !== previousKey;

            if (needsAttributes) {
                this.push('      <attributes>\n');
                if (barIndex === 0) {
                    this.push('        <divisions>' + this.division + '</divisions>\n');
                }
                if (activeKey !== previousKey || barIndex === 0) {
                    this.push('        <key><fifths>' + activeKey + '</fifths></key>\n');
                }
                if (activeTime !== previousTime || barIndex === 0) {
                    this.push('        <time><beats>' + activeTime.numerator +
                        '</beats><beat-type>' + activeTime.denominator +
                        '</beat-type></time>\n');
                }
                if (barIndex === 0) {
                    if (this.staffCount > 1) {
                        this.push('        <staves>2</staves>\n');
                        this.push('        <clef number="1"><sign>G</sign><line>2</line></clef>\n');
                        this.push('        <clef number="2"><sign>F</sign><line>4</line></clef>\n');
                    } else if (singleStaffIsBass) {
                        this.push('        <clef><sign>F</sign><line>4</line></clef>\n');
                    } else {
                        this.push('        <clef><sign>G</sign><line>2</line></clef>\n');
                    }
                }
                this.push('      </attributes>\n');
            }
            previousTime = activeTime;
            previousKey = activeKey;

            if (barIndex === 0) this.writeTempo();

            this.writeBarContent(bar, segments, barIndex);
            this.push('    </measure>\n');
        }

        this.push('  </part>\n');
    };

    MusicXmlBuilder.prototype.writeTempo = function () {
        var tempos = this.midi.tempos;
        var micros = null;
        for (var i = 0; i < tempos.length; i++) {
            if (tempos[i].tick <= 0) { micros = tempos[i].value; break; }
        }
        if (micros === null && tempos.length > 0) micros = tempos[0].value;
        if (micros === null) return;
        var bpm = Math.trunc(60000000.0 / micros);
        if (bpm < 20) bpm = 20;
        if (bpm > 400) bpm = 400;
        this.push('      <direction placement="above">\n');
        this.push('        <direction-type>\n');
        this.push('          <metronome><beat-unit>quarter</beat-unit><per-minute>' +
            bpm + '</per-minute></metronome>\n');
        this.push('        </direction-type>\n');
        this.push('        <sound tempo="' + bpm + '"/>\n');
        this.push('      </direction>\n');
    };

    MusicXmlBuilder.prototype.writeBarContent = function (bar, segments, barIndex) {
        var barLength = bar.end - bar.start;

        for (var staff = 0; staff < this.staffCount; staff++) {
            // MusicXML 流是线性的：每个谱表都要回到小节线重新开始。
            if (staff > 0) {
                this.push('      <backup><duration>' + barLength + '</duration></backup>\n');
            }

            var staffSegments = segments[staff][barIndex];
            if (staffSegments.length === 0) {
                this.push('      <note><rest measure="yes"/>');
                this.push('<duration>' + barLength + '</duration>');
                this.push('<voice>1</voice>');
                this.writeStaff(staff);
                this.push('</note>\n');
                continue;
            }

            var voices = assignVoices(staffSegments);
            for (var voiceIndex = 0; voiceIndex < voices.length; voiceIndex++) {
                if (voiceIndex > 0) {
                    this.push('      <backup><duration>' + barLength + '</duration></backup>\n');
                }
                this.writeVoice(bar, voices[voiceIndex], voiceIndex + 1, staff);
            }
        }
    };

    MusicXmlBuilder.prototype.writeVoice = function (bar, voice, voiceNumber, staff) {
        var cursor = bar.start;
        for (var i = 0; i < voice.length; i++) {
            var segment = voice[i];
            if (segment.start > cursor) {
                this.writeRest(cursor, segment.start, voiceNumber, staff);
            }
            this.writeChord(segment, voiceNumber, staff);
            cursor = segment.end;
        }
        if (cursor < bar.end) {
            this.writeRest(cursor, bar.end, voiceNumber, staff);
        }
    };

    MusicXmlBuilder.prototype.writeRest = function (start, end, voiceNumber, staff) {
        var duration = end - start;
        if (duration <= 0) return;
        this.push('      <note><rest/>');
        this.push('<duration>' + duration + '</duration>');
        this.push('<voice>' + voiceNumber + '</voice>');
        this.writeType(duration);
        this.writeStaff(staff);
        this.push('</note>\n');
    };

    MusicXmlBuilder.prototype.writeChord = function (segment, voiceNumber, staff) {
        var duration = segment.end - segment.start;
        if (duration <= 0) return;
        var pitches = segment.pitches.slice().sort(function (a, b) { return a - b; });
        for (var noteIndex = 0; noteIndex < pitches.length; noteIndex++) {
            var pitch = pitches[noteIndex];
            this.push('      <note>');
            if (noteIndex > 0) this.push('<chord/>');
            this.push('<pitch>');
            this.push('<step>' + STEPS[pitch % 12] + '</step>');
            var alter = ALTERS[pitch % 12];
            if (alter !== 0) this.push('<alter>' + alter + '</alter>');
            this.push('<octave>' + (Math.floor(pitch / 12) - 1) + '</octave>');
            this.push('</pitch>');
            this.push('<duration>' + duration + '</duration>');
            if (segment.tieStop) this.push('<tie type="stop"/>');
            if (segment.tieStart) this.push('<tie type="start"/>');
            this.push('<voice>' + voiceNumber + '</voice>');
            this.writeType(duration);
            this.writeStaff(staff);
            if (segment.tieStop || segment.tieStart) {
                this.push('<notations>');
                if (segment.tieStop) this.push('<tied type="stop"/>');
                if (segment.tieStart) this.push('<tied type="start"/>');
                this.push('</notations>');
            }
            this.push('</note>\n');
        }
    };

    MusicXmlBuilder.prototype.writeStaff = function (staff) {
        if (this.staffCount > 1) this.push('<staff>' + (staff + 1) + '</staff>');
    };

    MusicXmlBuilder.prototype.writeType = function (duration) {
        var type = noteTypeFor(duration / this.division);
        if (!type) return;
        this.push('<type>' + type.name + '</type>');
        for (var i = 0; i < type.dots; i++) this.push('<dot/>');
        if (type.triplet) {
            this.push('<time-modification><actual-notes>3</actual-notes>');
            this.push('<normal-notes>2</normal-notes></time-modification>');
        }
    };

    MusicXmlBuilder.prototype.buildTrackStaff = function () {
        var result = new Map();
        if (!this.splitByTrack) return result;
        // 平均音高更低的轨道成为低声部谱表。
        var byPitch = [];
        for (var index = 0; index < this.noteTracks.length; index++) {
            var notes = this.noteTracks[index].notes;
            var sum = 0;
            for (var i = 0; i < notes.length; i++) sum += notes[i].pitch;
            byPitch.push({ index: index, average: sum / notes.length });
        }
        byPitch.sort(function (a, b) { return a.average - b.average; });
        for (var rank = 0; rank < byPitch.length; rank++) {
            result.set(byPitch[rank].index, rank === 0 ? 1 : 0);
        }
        return result;
    };

    MusicXmlBuilder.prototype.buildStaffedNotes = function () {
        var result = [];
        var self = this;
        this.noteTracks.forEach(function (track, index) {
            var fixedStaff;
            if (self.staffCount === 1) fixedStaff = 0;
            else if (self.splitByTrack) fixedStaff = self.trackStaff.has(index) ? self.trackStaff.get(index) : 0;
            else fixedStaff = -1;

            for (var i = 0; i < track.notes.length; i++) {
                var note = track.notes[i];
                var staff = fixedStaff >= 0
                    ? fixedStaff
                    : (note.pitch >= SPLIT_PITCH ? 0 : 1);
                result.push(new StaffedNote(note, staff));
            }
        });
        return result;
    };

    MusicXmlBuilder.prototype.hasChordsAcrossMiddleC = function () {
        var all = [];
        for (var i = 0; i < this.noteTracks.length; i++) {
            all = all.concat(this.noteTracks[i].notes);
        }
        if (all.length === 0) return false;
        var low = Infinity;
        var high = -Infinity;
        for (var j = 0; j < all.length; j++) {
            if (all[j].pitch < low) low = all[j].pitch;
            if (all[j].pitch > high) high = all[j].pitch;
        }
        if (low >= SPLIT_PITCH || high < SPLIT_PITCH) return false;
        for (var t = 0; t < this.noteTracks.length; t++) {
            var chords = groupChords(this.noteTracks[t].notes, this.gridTicks);
            for (var c = 0; c < chords.length; c++) {
                if (chords[c].pitches.length > 1) return true;
            }
        }
        return false;
    };

    MusicXmlBuilder.prototype.distributeToBars = function () {
        var result = [];
        for (var s = 0; s < this.staffCount; s++) {
            var row = [];
            for (var b = 0; b < this.bars.length; b++) row.push([]);
            result.push(row);
        }

        for (var staff = 0; staff < this.staffCount; staff++) {
            var staffNotes = [];
            for (var i = 0; i < this.staffedNotes.length; i++) {
                if (this.staffedNotes[i].staff === staff) staffNotes.push(this.staffedNotes[i].note);
            }
            var chords = groupChords(staffNotes, this.gridTicks);
            for (var c = 0; c < chords.length; c++) {
                var chord = chords[c];
                var start = chord.start;
                while (start < chord.end) {
                    var barIndex = this.barIndexAt(start);
                    if (barIndex < 0) break;
                    var barEnd = this.bars[barIndex].end;
                    var end = Math.min(chord.end, barEnd);
                    result[staff][barIndex].push(new ChordSegment(
                        start,
                        end,
                        chord.pitches,
                        start > chord.start,
                        end < chord.end
                    ));
                    start = end;
                }
            }
        }
        return result;
    };

    function groupChords(notes, gridTicks) {
        var grouped = new Map();
        for (var i = 0; i < notes.length; i++) {
            var note = notes[i];
            if (note.endTick <= note.startTick) continue;
            var start = quantize(note.startTick, gridTicks);
            var end = Math.max(quantize(note.endTick, gridTicks), start + gridTicks);
            var key = start + ':' + end;
            if (!grouped.has(key)) grouped.set(key, { start: start, end: end, pitches: [] });
            grouped.get(key).pitches.push(note.pitch);
        }
        var chords = [];
        grouped.forEach(function (entry) {
            chords.push(new Chord(entry.start, entry.end, distinct(entry.pitches)));
        });
        chords.sort(function (a, b) { return a.start - b.start; });
        return chords;
    }

    function distinct(values) {
        var seen = new Set();
        var out = [];
        for (var i = 0; i < values.length; i++) {
            if (!seen.has(values[i])) { seen.add(values[i]); out.push(values[i]); }
        }
        return out;
    }

    function quantize(tick, gridTicks) {
        return Math.round(tick / gridTicks) * gridTicks;
    }

    function assignVoices(segments) {
        var sorted = segments.slice().sort(function (a, b) {
            if (a.start !== b.start) return a.start - b.start;
            return (b.end - b.start) - (a.end - a.start);
        });
        var voices = [];
        for (var i = 0; i < sorted.length; i++) {
            var segment = sorted[i];
            var placed = false;
            for (var v = 0; v < voices.length; v++) {
                var overlaps = false;
                for (var k = 0; k < voices[v].length; k++) {
                    var other = voices[v][k];
                    if (other.start < segment.end && other.end > segment.start) { overlaps = true; break; }
                }
                if (!overlaps) {
                    voices[v].push(segment);
                    placed = true;
                    break;
                }
            }
            if (!placed) voices.push([segment]);
        }
        return voices.map(function (voice) {
            return voice.slice().sort(function (a, b) { return a.start - b.start; });
        });
    }

    MusicXmlBuilder.prototype.buildBars = function () {
        var totalTicks = this.division * 4;
        for (var t = 0; t < this.midi.tracks.length; t++) {
            var notes = this.midi.tracks[t].notes;
            for (var n = 0; n < notes.length; n++) {
                if (notes[n].endTick > totalTicks) totalTicks = notes[n].endTick;
            }
        }

        var signatures = this.midi.timeSignatures.length > 0
            ? this.midi.timeSignatures
            : [new TimedValue(0, new TimeSignature(4, 4))];

        var result = [];
        var start = 0;
        var guard = 0;
        while (start < totalTicks && guard < 10000) {
            var signature = timeSignatureAt(start, signatures);
            var length = Math.max(1, Math.trunc(signature.quarterLength * this.division));
            result.push(new Bar(result.length, start, start + length, signature));
            start += length;
            guard++;
        }
        if (result.length === 0) {
            result.push(new Bar(0, 0, this.division * 4, new TimeSignature(4, 4)));
        }
        return result;
    };

    MusicXmlBuilder.prototype.timeSignatureAt = function (tick) {
        var signatures = this.midi.timeSignatures.length > 0
            ? this.midi.timeSignatures
            : [new TimedValue(0, new TimeSignature(4, 4))];
        return timeSignatureAt(tick, signatures);
    };

    function timeSignatureAt(tick, signatures) {
        var active = signatures[0].value;
        for (var i = 0; i < signatures.length; i++) {
            if (signatures[i].tick <= tick) active = signatures[i].value;
            else break;
        }
        return active;
    }

    MusicXmlBuilder.prototype.keySignatureAt = function (tick) {
        var signatures = this.midi.keySignatures;
        if (signatures.length === 0) return 0;
        var active = signatures[0].value;
        for (var i = 0; i < signatures.length; i++) {
            if (signatures[i].tick <= tick) active = signatures[i].value;
            else break;
        }
        return active;
    };

    MusicXmlBuilder.prototype.barIndexAt = function (tick) {
        var bars = this.bars;
        if (bars.length === 0) return -1;
        var low = 0;
        var high = bars.length - 1;
        while (low <= high) {
            var mid = (low + high) >> 1;
            var bar = bars[mid];
            if (tick < bar.start) high = mid - 1;
            else if (tick >= bar.end) low = mid + 1;
            else return mid;
        }
        return -1;
    };

    var BASES = [
        ['whole', 4.0],
        ['half', 2.0],
        ['quarter', 1.0],
        ['eighth', 0.5],
        ['16th', 0.25],
        ['32nd', 0.125],
        ['64th', 0.0625]
    ];

    function noteTypeFor(quarters) {
        if (quarters <= 0) return null;
        for (var i = 0; i < BASES.length; i++) {
            var name = BASES[i][0];
            var base = BASES[i][1];
            if (Math.abs(quarters - base * 2.0 / 3.0) < EPSILON) {
                return { name: name, dots: 0, triplet: true };
            }
            for (var dots = 0; dots <= 2; dots++) {
                var value = base * (2.0 - 1.0 / (1 << dots));
                if (Math.abs(quarters - value) < EPSILON) {
                    return { name: name, dots: dots, triplet: false };
                }
            }
        }
        // 不是可以直接记谱的时值（例如四分加十六分）：退回到最接近的简单时值，
        // 免得 alphaTab 自己去猜连音符。
        var fallback = null;
        for (var b = 0; b < BASES.length; b++) {
            if (BASES[b][1] <= quarters) { fallback = BASES[b]; break; }
        }
        if (!fallback) fallback = BASES[BASES.length - 1];
        return { name: fallback[0], dots: 0, triplet: false };
    }

    function escapeXml(value) {
        var out = '';
        for (var i = 0; i < value.length; i++) {
            var ch = value[i];
            if (ch === '&') out += '&amp;';
            else if (ch === '<') out += '&lt;';
            else if (ch === '>') out += '&gt;';
            else if (ch === '"') out += '&quot;';
            else if (ch === "'") out += '&apos;';
            else out += ch;
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* 对外接口：格式识别与导入准备                                          */
    /* ------------------------------------------------------------------ */

    var ScoreFormat = {
        MIDI: 'MIDI',
        MUSIC_XML: 'MUSIC_XML',
        MUSIC_XML_COMPRESSED: 'MUSIC_XML_COMPRESSED',
        UNKNOWN: 'UNKNOWN'
    };

    var FORMAT_LABELS = {
        MIDI: 'MIDI',
        MUSIC_XML: 'MusicXML',
        MUSIC_XML_COMPRESSED: 'MusicXML (MXL)',
        UNKNOWN: '未知格式'
    };

    function detectFormat(bytes, fileName) {
        var name = (fileName || '').toLowerCase();
        if (startsWith(bytes, [0x4D, 0x54, 0x68, 0x64])) return ScoreFormat.MIDI;
        if (startsWith(bytes, [0x50, 0x4B, 0x03, 0x04])) {
            return name.endsWith('.mxl') ? ScoreFormat.MUSIC_XML_COMPRESSED : ScoreFormat.UNKNOWN;
        }
        if (looksLikeMusicXml(bytes)) {
            return name.endsWith('.mxl') ? ScoreFormat.MUSIC_XML_COMPRESSED : ScoreFormat.MUSIC_XML;
        }
        if (name.endsWith('.mid') || name.endsWith('.midi')) return ScoreFormat.MIDI;
        if (name.endsWith('.musicxml') || name.endsWith('.xml')) return ScoreFormat.MUSIC_XML;
        if (name.endsWith('.mxl')) return ScoreFormat.MUSIC_XML_COMPRESSED;
        return ScoreFormat.UNKNOWN;
    }

    function startsWith(bytes, prefix) {
        if (bytes.length < prefix.length) return false;
        for (var i = 0; i < prefix.length; i++) {
            if (bytes[i] !== prefix[i]) return false;
        }
        return true;
    }

    function looksLikeMusicXml(bytes) {
        var length = Math.min(bytes.length, 512);
        var head = utf8Of(bytes, 0, length).replace(/^[\uFEFF \t\r\n]+/, '');
        if (head.charAt(0) !== '<') return false;
        var lower = head.toLowerCase();
        return lower.indexOf('score-partwise') >= 0 ||
            lower.indexOf('score-timewise') >= 0 ||
            lower.indexOf('<?xml') >= 0;
    }

    /**
     * 把导入的乐谱规范化为 viewer 能渲染的负载：MIDI 翻译成 MusicXML，其余原样透传。
     */
    function prepare(displayName, sourceFormat, bytes) {
        if (sourceFormat === ScoreFormat.MIDI) {
            var xml = convertMidi(bytes);
            var encoded = new TextEncoder().encode(xml);
            return {
                displayName: displayName,
                sourceFormat: sourceFormat,
                renderFormat: ScoreFormat.MUSIC_XML,
                bytes: encoded
            };
        }
        return {
            displayName: displayName,
            sourceFormat: sourceFormat,
            renderFormat: sourceFormat,
            bytes: bytes
        };
    }

    function convertMidi(bytes) {
        var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return new MusicXmlBuilder(readMidi(data)).build();
    }

    global.PianoMidi = {
        convert: convertMidi,
        ScoreFormat: ScoreFormat,
        formatLabel: function (format) { return FORMAT_LABELS[format] || format; },
        detectFormat: detectFormat,
        prepare: prepare,
        MidiConversionException: MidiConversionException
    };
})(window);
