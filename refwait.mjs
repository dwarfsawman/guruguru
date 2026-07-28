const BASE="http://127.0.0.1:5199";
const PID="project_1ed9d6e0-8f66-4d4b-ae8c-c81b5b6ac31b";
const sets=JSON.parse(await Bun.file("refsets.json").text());
for(let t=0;t<180;t++){
  const all=(await (await fetch(`${BASE}/api/projects/${PID}/reference-sets`)).json()).referenceSets??[];
  const mine=sets.map(s=>all.find(x=>x.id===s.setId)).filter(Boolean);
  const st=mine.map(m=>`${m.characterName}:${m.status}`).join(" ");
  if(t%6===0) console.log(st);
  if(mine.every(m=>m.status!=="generating")){ console.log("DONE", st); 
    console.log(JSON.stringify(mine.map(m=>({id:m.id,status:m.status,images:(m.images??[]).map(i=>({role:i.role,url:i.imageUrl,candidates:(i.candidateAssetIds??[]).length}))})),null,1).slice(0,1500));
    break; }
  await new Promise(r=>setTimeout(r,10000));
}
