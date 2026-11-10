const from=__FROM__,to=__TO__
const V=GetVariables().variables, modes=["dark","light","gaming"]
const val=(n,m)=>V[n].value.find(e=>e.theme.mode===m).value
const pref=["foreground","background","card","popover","muted-foreground","secondary","border","input","primary","primary-foreground","accent","warning","success","info","destructive","destructive-text","destructive-foreground","selection","brand-secondary","discord","discord-text","meter-danger","aurora-green","aurora-teal","aurora-rose","overlay"]
const base=Object.keys(V).filter(n=>!/-a\d+$/.test(n))
const names=[...pref.filter(n=>base.includes(n)),...base.filter(n=>!pref.includes(n))]
const rgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16))
const lut=names.map(n=>[n,rgb(val(n,"dark"))])
const add={}, memo=new Map(), miss={}
const f0=c=>{ let h=c.toLowerCase(); if(h.length===4) h="#"+[...h.slice(1)].map(x=>x+x).join(""); const a=h.length===9?h.slice(7):""; if(a==="00") return c
 const p=rgb(h); const hit=lut.find(([n,v])=>v.every((x,i)=>Math.abs(x-p[i])<=1)&&!(n==="overlay"&&(!a||a==="ff"))); if(!hit){miss[h]=(miss[h]||0)+1; return c}
 if(!a||a==="ff") return "$"+hit[0]; const vn=hit[0]+"-a"+Math.round(parseInt(a,16)/2.55); if(!V[vn]&&!add[vn]) add[vn]={type:"color",value:modes.map(m=>({value:val(hit[0],m)+a,theme:{mode:m}}))}; return "$"+vn }
const mc=c=>{ if(typeof c!=="string"||c[0]!=="#") return c; if(!memo.has(c)) memo.set(c,f0(c)); return memo.get(c) }
const mf=f=>Array.isArray(f)?f.map(mf):typeof f==="string"?mc(f):f&&f.type==="color"?{...f,color:mc(f.color)}:f&&f.type==="gradient"&&f.colors?{...f,colors:f.colors.map(s=>({...s,color:mc(s.color)}))}:f
const screens=Get((n,c)=>{ if(c.depth===0){ c.skipChildren(); return n.type==="frame"&&!n.reusable&&!/^(Components|②|③)/.test(n.name||"")?n.id:undefined } return undefined })
const batch=screens.slice(from,to), ups=[]
for(const s of batch) Get(s,n=>{ const u={}; for(const k of ["fill","stroke"]) if(n[k]!==undefined){ const v=mf(n[k]); if(JSON.stringify(v)!==JSON.stringify(n[k])) u[k]=v } if(Object.keys(u).length) ups.push([n.id,u]); return undefined })
if(Object.keys(add).length) SetVariables(add)
for(const [id,u] of ups) Update(id,u)
for(const s of batch) Update(s,{theme:{mode:"dark"}})
Print("screens",from,"-",to,"of",screens.length,"updated",ups.length,"newvars",Object.keys(add).length,"unmatched",JSON.stringify(miss))
