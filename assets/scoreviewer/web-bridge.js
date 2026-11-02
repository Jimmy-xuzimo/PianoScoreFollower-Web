/* Parent-frame adaptation; the renderer remains shared with Android. */
window.AndroidHost={postEvent(raw){const data=JSON.parse(raw);parent.postMessage(data,location.origin);}};
window.addEventListener('message',e=>{if(e.source!==parent||e.origin!==location.origin||!e.data?.pianoViewer)return;const api=window.PianoScoreViewer;const name=e.data.method;if(api&&typeof api[name]==='function'&&!name.startsWith('_')){try{api[name](...(e.data.args||[]));}catch(error){parent.postMessage({type:'error',message:error.message||String(error)},location.origin);}}});
