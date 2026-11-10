const T=__TOKENS__
const modes=["dark","light","gaming"]
const vars={}
for(const [n,v] of Object.entries(T)) vars[n]={type:"color",value:modes.map(m=>({value:v[m],theme:{mode:m}}))}
const V=GetVariables().variables
for(const [n,def] of Object.entries(V)){
  const m=/^(.+)-a(\d+)$/.exec(n)
  if(m&&T[m[1]]){ const a=def.value[0].value.slice(7); vars[n]={type:"color",value:modes.map(md=>({value:T[m[1]][md]+a,theme:{mode:md}}))} }
}
SetVariables(vars)
Print("variables set",Object.keys(vars).length)
