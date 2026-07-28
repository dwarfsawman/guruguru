const BASE="http://127.0.0.1:5199";
const meta=JSON.parse(await Bun.file("C:/Users/raven/work/mangaWorks/gakuen/02_model_tests/refsets/index.json").text());
const PICK={"高梨 澪":{face:1,full_body:2},"灰田 累":{face:2,full_body:2},"篠塚 先生":{face:1,full_body:2}};
const bySet=new Map();
for(const m of meta){ if(!bySet.has(m.setId)) bySet.set(m.setId,{name:m.name,roles:{}}); bySet.get(m.setId).roles[m.role]=m.files; }
for(const [setId,info] of bySet){
  const pick=PICK[info.name]??{face:1,full_body:1};
  const body={};
  for(const role of ["face","full_body"]){
    const files=info.roles[role]??[];
    const chosen=files.find(f=>f.idx===pick[role]) ?? files[0];
    if(chosen) body[role==="face"?"faceAssetId":"fullBodyAssetId"]=chosen.assetId;
  }
  const r=await fetch(`${BASE}/api/reference-sets/${setId}/approve`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const t=await r.text();
  console.log(info.name, r.status, r.ok ? JSON.parse(t).status ?? JSON.parse(t).referenceSet?.status : t.slice(0,180));
}
