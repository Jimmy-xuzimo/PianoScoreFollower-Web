/* The same exporter is used by Android and the offline evaluation harness. */
(function(root, factory) {
    if (typeof module === 'object') module.exports = factory();
    else root.ScoreGraphExporter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    function build(AT, score, selected, staffs) {
        var settings = new AT.Settings();
        var file = new AT.midi.MidiFile();
        var generator = new AT.midi.MidiFileGenerator(score, settings, new AT.midi.AlphaSynthMidiFileHandler(file));
        generator.generate();
        var order = generator.tickLookup.masterBars;
        var visits = {}, bars = [];
        order.forEach(function(played) {
            var mb = played.masterBar, index = mb.index;
            var occurrence = visits[index] || 0;
            visits[index] = occurrence + 1;
            var notes = [], starts = new Set([0]);
            score.tracks.forEach(function(track, ti) {
                if (selected && selected.indexOf(ti) < 0) return;
                track.staves.forEach(function(staff, si) {
                    if (staffs && staffs.indexOf(si) < 0) return;
                    var bar = staff.bars[index];
                    if (!bar) return;
                    bar.voices.forEach(function(voice) {
                        voice.beats.forEach(function(beat) {
                            var range = generator.tickLookup.getRelativeBeatPlaybackRange(beat);
                            var start = range ? range.startTick : beat.playbackStart;
                            var duration = range ? range.endTick-range.startTick : beat.playbackDuration;
                            if (beat.notes && beat.notes.length && start >= played.end-played.start)
                                throw new Error('第 '+(index+1)+' 小节的声部时值超出小节范围，请修正 MusicXML 后重新导入');
                            starts.add(start);
                            (beat.notes || []).forEach(function(note) {
                                if (note.isDead || note.realValue < 0 || note.realValue > 127) return;
                                notes.push({ pitch: note.realValue, start: start,
                                    end: start + duration, attack: !note.isTieDestination, track: ti, staff: si, voice: voice.index, tied: note.isTieDestination });
                            });
                        });
                    });
                });
            });
            var ticks = Array.from(starts).sort(function(a,b) { return a-b; });
            var tempo = played.tempoChanges && played.tempoChanges.length ? played.tempoChanges[0].tempo : (score.tempo || 120);
            var events = ticks.map(function(t, i) {
                var attacks = notes.filter(function(n) { return n.start === t && n.attack; });
                var sounding = notes.filter(function(n) { return n.start <= t && n.end > t; });
                var activeTempo=tempo;
                (played.tempoChanges || []).forEach(function(change) { if(change.tick<=played.start+t) activeTempo=change.tempo; });
                return { tick: played.start + t, notationTick: mb.start + t, tempo:activeTempo,
                    duration: (i+1 < ticks.length ? ticks[i+1] : played.end-played.start) - t,
                    voices: sounding.map(function(n) { return { pitch:n.pitch,track:n.track,staff:n.staff,voice:n.voice,tied:n.tied,start:played.start+n.start,end:played.start+n.end }; }),
                    notes: Array.from(new Set(attacks.map(function(n) { return n.pitch; }))),
                    sounding: Array.from(new Set(sounding.map(function(n) { return n.pitch; }))) };
            });
            bars.push({ index: index, occurrence: occurrence, start: played.start, end: played.end,
                tempo: tempo, events: events });
        });
        return { ticksPerQuarter: 960, selectedTracks: selected || score.tracks.map(function(t,i) { return i; }), bars: bars };
    }
    return { build: build };
});
