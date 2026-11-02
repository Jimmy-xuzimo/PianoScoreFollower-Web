(function(root,factory){if(typeof module==='object')module.exports=factory();else root.FollowNavigation=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
    'use strict';
    function Anchor(){this.reset(null,-1);}
    Anchor.prototype.reset=function(tick,system){this.tick=tick;this.system=system;this.pending=-1;this.since=0;};
    Anchor.prototype.update=function(tick,system,now){
        if(tick===null){this.reset(null,-1);return null;}
        // Small timing corrections may move the cursor within the score. A
        // correction across a line edge must persist before moving the viewport.
        var smallBack=this.tick!==null && tick<this.tick && this.tick-tick<=1920;
        if(smallBack && system!==this.system && system>=0){
            if(this.pending!==system){this.pending=system;this.since=now;}
            if(now-this.since<650)return this.tick;
        }
        this.reset(tick,system);return tick;
    };
    return {Anchor:Anchor};
});
