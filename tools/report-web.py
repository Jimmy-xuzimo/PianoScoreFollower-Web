import json,sys,hashlib
from pathlib import Path
import numpy as np
rows=[]
for folder in Path(sys.argv[1]).read_text().splitlines():
 p=Path(folder);a=np.genfromtxt(p/'web-trace.tsv',dtype=str,delimiter='\t');t=a[:,0].astype(float);q=a[:,1].astype(float);truth=np.loadtxt(p/'truth.tsv');mask=(t>=truth[0,0])&(t<=min(truth[-1,0],t[-1]));error=abs(q-np.interp(t,truth[:,0],truth[:,1]))/960
 rows.append(dict(name=p.name,seconds=float(mask.sum()*1024/44100),within_half_beat=float(np.mean(error[mask]<=.5)),median_error_beats=float(np.median(error[mask])),p95_error_beats=float(np.quantile(error[mask],.95))))
result=dict(cases=rows,within_half_beat=sum(r['seconds']*r['within_half_beat'] for r in rows)/sum(r['seconds'] for r in rows),sha256={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('js/core').glob('*.js')})
print(json.dumps(result,indent=2))
