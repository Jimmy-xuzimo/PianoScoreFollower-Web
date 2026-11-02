/* Jianpu shares the exported playback graph; printed repeats are drawn once. */
(function(root,factory){if(typeof module==='object')module.exports=factory();else root.NumberedScore=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    var scale=[0,2,4,5,7,9,11], tonics=[11,6,1,8,3,10,5,0,7,2,9,4,11,6,1];
    var names=['C','D♭','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
    function pitch(midi,key){
        var tonic=tonics[Math.max(0,Math.min(14,key+7))], relative=midi-60-tonic;
        var octave=Math.floor(relative/12), pc=((relative%12)+12)%12, degree=scale.indexOf(pc), accidental='';
        if(degree<0){
            if(key<0){degree=scale.findIndex(function(n){return n>pc;});accidental='♭';}
            else {degree=scale.findIndex(function(n){return n===pc-1;});accidental='♯';}
        }
        return {digit:degree+1,accidental:accidental,octave:octave};
    }
    function rhythm(duration,quarter){
        var beats=duration/quarter, units=[4,2,1,.5,.25,.125,.0625], base=units.find(function(n){return Math.abs(beats-n)<.002;});
        var dots=0;
        if(!base) for(var d=1;d<=2&&!base;d++) {base=units.find(function(n){return Math.abs(beats-n*(2-Math.pow(.5,d)))<.002;});if(base)dots=d;}
        if(!base) base=units.find(function(n){return n<=beats;}) || .0625;
        return {lines:Math.max(0,Math.round(-Math.log2(base))),dots:dots,dashes:base>=1?Math.floor(base)-1:0,
            irregular:!units.some(function(n){return Math.abs(beats-n*(2-Math.pow(.5,dots)))<.002;}),beats:beats};
    }
    function model(graph,score){
        var seen=new Set();
        return graph.bars.filter(function(b){if(seen.has(b.index))return false;seen.add(b.index);return true;}).sort(function(a,b){return a.index-b.index;}).map(function(bar){
            var mb=score.masterBars[bar.index], lanes=new Map(), unique=new Set();
            bar.events.forEach(function(e){e.voices.forEach(function(n){
                if(n.start<bar.start || n.start>=bar.end)return;
                var id=[n.track,n.staff,n.voice,n.start,n.pitch].join(':');if(unique.has(id))return;unique.add(id);
                var laneId=[n.track,n.staff,n.voice].join(':');
                if(!lanes.has(laneId))lanes.set(laneId,{track:n.track,staff:n.staff,voice:n.voice,notes:[]});
                lanes.get(laneId).notes.push({start:n.start-bar.start,end:Math.min(n.end,bar.end)-bar.start,pitch:n.pitch,tied:n.tied,tick:n.start});
            });});
            // A selected voice can be entirely resting in this measure.
            (graph.selectedTracks || []).forEach(function(t){score.tracks[t].staves.forEach(function(s,si){
                if(graph.selectedStaffs && graph.selectedStaffs.indexOf(si)<0)return;
                var b=s.bars[bar.index];if(!b)return;
                b.voices.forEach(function(v){var id=[t,si,v.index].join(':');if(!lanes.has(id))lanes.set(id,{track:t,staff:si,voice:v.index,notes:[]});});
            });});
            var all=Array.from(lanes.values());
            var out=all.filter(function(l){return l.notes.length || !all.some(function(other){return other.track===l.track && other.staff===l.staff && (other.notes.length || other.voice<l.voice);});}).sort(function(a,b){return a.track-b.track||a.staff-b.staff||a.voice-b.voice;});
            out.forEach(function(lane){
                var source=score.tracks[lane.track].staves[lane.staff].bars[bar.index];lane.key=source.keySignature||0;
                var grouped=new Map();lane.notes.forEach(function(n){var id=n.start+':'+n.end;if(!grouped.has(id))grouped.set(id,{start:n.start,end:n.end,notes:[],tick:n.tick});grouped.get(id).notes.push(n);});
                lane.cells=Array.from(grouped.values()).sort(function(a,b){return a.start-b.start;});
                var end=0,rests=[];lane.cells.forEach(function(c){if(c.start>end)rests.push({start:end,end:c.start,notes:[],tick:bar.start+end});end=Math.max(end,c.end);});
                if(end<bar.end-bar.start)rests.push({start:end,end:bar.end-bar.start,notes:[],tick:bar.start+end});
                lane.cells=lane.cells.concat(rests).sort(function(a,b){return a.start-b.start;});
            });
            return {index:bar.index,start:bar.start,end:bar.end,lanes:out,meter:mb.timeSignatureNumerator+'/'+mb.timeSignatureDenominator,
                repeatStart:!!mb.isRepeatStart,repeatEnd:mb.repeatCount>0};
        });
    }
    function points(bar,quarter) {
        var ticks=new Set([0,bar.end-bar.start]);
        bar.lanes.forEach(function(l){l.cells.forEach(function(c){
            ticks.add(c.start);ticks.add(c.end);
            for(var t=c.start+quarter;t<c.end;t+=quarter)ticks.add(t);
        });});
        return Array.from(ticks).sort(function(a,b){return a-b;});
    }
    // Width is shared across both hands. A long note starts on the same column
    // as a simultaneous short note; it is never centred across its duration.
    function systems(bars,width,quarter) {
        var result=[], current=[], used=0, available=Math.max(180,width-62);
        bars.forEach(function(bar){
            var weight=Math.max(155,(points(bar,quarter).length-1)*46+24);
            if(current.length && (used+weight>available || current.length>=4)) {result.push(current);current=[];used=0;}
            current.push({bar:bar,weight:weight});used+=weight;
        });
        if(current.length)result.push(current);
        return result;
    }
    function render(container,graph,score,onSeek){
        container.replaceChildren();
        function el(tag,cls,text){var e=document.createElement(tag);e.className=cls;if(text!==undefined)e.textContent=text;return e;}
        var bars=model(graph,score), quarter=graph.ticksPerQuarter;
        container.appendChild(el('div','numbered-heading',score.title||'钢琴简谱'));
        var first=bars[0], key=first&&first.lanes[0]?first.lanes[0].key:0;
        container.appendChild(el('div','numbered-meta','1='+names[tonics[key+7]]+'　'+(first?first.meter:'')+'　♩ = '+(Math.round((score.tempo||120)*100)/100)));
        systems(bars,container.clientWidth-32,quarter).forEach(function(group){
            var system=el('section','numbered-system');
            system.appendChild(el('div','numbered-system-number','('+(group[0].bar.index+1)+')'));
            var handIds=[];
            group.forEach(function(entry){entry.bar.lanes.forEach(function(l){var id=l.track+':'+l.staff;if(handIds.indexOf(id)<0)handIds.push(id);});});
            handIds.sort(function(a,b){var x=a.split(':').map(Number),y=b.split(':').map(Number);return x[0]-y[0]||x[1]-y[1];});
            var voices={}, heights={};
            handIds.forEach(function(id){
                var list=[];group.forEach(function(e){e.bar.lanes.filter(function(l){return l.track+':'+l.staff===id;}).forEach(function(l){if(list.indexOf(l.voice)<0)list.push(l.voice);});});
                voices[id]=list.sort(function(a,b){return a-b;});
                heights[id]=voices[id].map(function(v){
                    var h=72;group.forEach(function(e){e.bar.lanes.filter(function(l){return l.track+':'+l.staff===id&&l.voice===v;}).forEach(function(l){l.cells.forEach(function(c){h=Math.max(h,c.notes.reduce(function(sum,n){return sum+52+Math.abs(pitch(n.pitch,l.key).octave)*6;},0)+14);});});});return h;
                });
            });
            var body=el('div','numbered-system-body'), gutter=el('div','numbered-gutter');
            var total=handIds.reduce(function(sum,id){return sum+heights[id].reduce(function(a,b){return a+b;},0);},0);
            if(handIds.length>1) {
                var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 22 100');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('class','numbered-brace');
                var path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M20 1 C3 10 17 38 3 50 C17 62 3 90 20 99');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.7');svg.appendChild(path);gutter.appendChild(svg);
            }
            handIds.forEach(function(id){var label=el('div','numbered-hand','');label.style.height=heights[id].reduce(function(a,b){return a+b;},0)+'px';gutter.appendChild(label);});
            body.appendChild(gutter);
            group.forEach(function(entry){
                var bar=entry.bar, measure=el('div','numbered-bar');measure.dataset.measure=bar.index;measure.style.flexGrow=entry.weight;measure.style.flexBasis='0';
                var ticks=points(bar,quarter), columns='repeat('+(ticks.length-1)+', minmax(0,1fr))';
                handIds.forEach(function(id){
                    var hand=el('div','numbered-hand-row');hand.dataset.hand=id;
                    voices[id].forEach(function(voice,vi){
                        var lane=bar.lanes.find(function(l){return l.track+':'+l.staff===id&&l.voice===voice;});
                        var row=el('div','numbered-lane');row.style.gridTemplateColumns=columns;row.style.height=heights[id][vi]+'px';
                        if(lane)lane.cells.forEach(function(c){
                            var r=rhythm(c.end-c.start,quarter), beats=(c.end-c.start)/quarter;
                            var glyph=el('div','numbered-cell');glyph.dataset.tick=c.tick;glyph.dataset.end=c.tick+(c.end-c.start);glyph.dataset.measure=bar.index;
                            glyph.style.gridColumn=(ticks.indexOf(c.start)+1)+' / '+(ticks.indexOf(c.start)+2);
                            var chord=el('div','numbered-chord');
                            (c.notes.length?c.notes.slice().sort(function(a,b){return b.pitch-a.pitch;}):[{pitch:null}]).forEach(function(n){
                                var p=n.pitch===null?{digit:0,octave:0,accidental:''}:pitch(n.pitch,lane.key);
                                var note=el('span','numbered-note');if(n.pitch!==null)note.dataset.pitch=n.pitch;
                                var upper=el('span','octave above');for(var i=0;i<Math.max(0,p.octave);i++)upper.appendChild(el('b','','·'));note.appendChild(upper);
                                var digit=el('span','numbered-digit',p.digit);note.appendChild(digit);
                                if(p.accidental)note.appendChild(el('span','numbered-accidental',p.accidental));
                                if(r.dots && beats<2)note.appendChild(el('span','numbered-dot','·'.repeat(r.dots)));
                                for(var i=0;i<r.lines;i++){var line=el('i','duration-line');line.style.bottom=(-3-i*3)+'px';note.appendChild(line);}
                                var lower=el('span','octave below');lower.style.top=(29+r.lines*3)+'px';for(var i=0;i<Math.max(0,-p.octave);i++)lower.appendChild(el('b','','·'));note.appendChild(lower);
                                if(n.tied){var tie=el('span','numbered-tie','⌒');tie.style.top=(-24-Math.max(0,p.octave)*6)+'px';note.appendChild(tie);}
                                chord.appendChild(note);
                            });glyph.appendChild(chord);
                            if(r.irregular)glyph.appendChild(el('small','numbered-irregular',Number(r.beats.toFixed(3))+'拍'));
                            glyph.addEventListener('click',function(){onSeek(c.tick,bar.index);});row.appendChild(glyph);
                            for(var t=c.start+quarter;t<c.end && beats>=2;t+=quarter){
                                var dash=el('div','numbered-cell numbered-dash','—');dash.dataset.tick=bar.start+t;dash.dataset.end=bar.start+Math.min(t+quarter,c.end);dash.dataset.measure=bar.index;
                                dash.style.gridColumn=(ticks.indexOf(t)+1)+' / '+(ticks.indexOf(t)+2);
                                (function(t){dash.addEventListener('click',function(){onSeek(bar.start+t,bar.index);});})(t);row.appendChild(dash);
                            }
                        });
                        else {var rest=el('div','numbered-cell','0');rest.dataset.tick=bar.start;rest.dataset.end=bar.end;row.appendChild(rest);}
                        hand.appendChild(row);
                    });measure.appendChild(hand);
                });
                if(bar.repeatStart)measure.classList.add('repeat-start');if(bar.repeatEnd)measure.classList.add('repeat-end');
                if(bar.index===bars[bars.length-1].index)measure.classList.add('final-bar');
                if(bar.index>0 && (bar.meter!==bars[bar.index-1]?.meter || bar.lanes[0]?.key!==bars[bar.index-1]?.lanes[0]?.key))measure.appendChild(el('span','numbered-change','1='+names[tonics[(bar.lanes[0]?.key||0)+7]]+' '+bar.meter));
                body.appendChild(measure);
            });system.appendChild(body);container.appendChild(system);
        });
    }
    return {pitch:pitch,rhythm:rhythm,model:model,points:points,systems:systems,render:render};
});
