const BASE="http://127.0.0.1:5199";
const PID="project_1ed9d6e0-8f66-4d4b-ae8c-c81b5b6ac31b";
const TPL="template_29f84c16-20fa-4b86-9d78-c3a6589d4100";
const j=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{"Content-Type":"application/json"},body:b?JSON.stringify(b):undefined});const t=await r.text();if(!r.ok)throw new Error(`${m} ${p} ${r.status}: ${t.slice(0,300)}`);return t?JSON.parse(t):null;};

const chars=(await j("GET",`/api/projects/${PID}/characters`)).characters;
const SPEC={
 "高梨 澪":{ja:"黒髪ショートボブ、ぱっつん前髪、切れ長の落ち着いた目、小柄、濃色ブレザー制服にリボン、こめかみに無地の丸い跡",
  en:"1girl, 17 years old, short black bob cut, blunt bangs, narrow calm dark eyes, small stature, dark blazer school uniform, ribbon at collar, faint blank round mark on temple, reserved expression",
  keep:["short black bob cut","blunt bangs","dark blazer with ribbon"]},
 "灰田 累":{ja:"癖のある短い黒髪、目の下に隈、猫背、濃色ブレザーの袖が長く手の甲まで届く、こめかみに無地の白い四角シール",
  en:"1boy, 17 years old, messy short black hair, dark circles under eyes, slouching posture, dark blazer school uniform, overlong sleeves covering hands, blank white square sticker on temple",
  keep:["messy short black hair","dark circles under eyes","overlong sleeves"]},
 "篠塚 先生":{ja:"40代の男性教師、灰色カーディガン、細い銀縁眼鏡、短く整えた髪、姿勢がよい",
  en:"1man, 40 years old, male teacher, grey cardigan over dress shirt, thin silver-rimmed glasses, short neat black hair, upright posture, calm face",
  keep:["grey cardigan","thin silver-rimmed glasses"]}
};
const out=[];
for (const [name,spec] of Object.entries(SPEC)) {
  const c=chars.find(x=>x.name===name);
  if(!c){console.log("missing char",name);continue;}
  const set=await j("POST",`/api/characters/${c.id}/reference-sets`,{
    variantId:"default", modelFamily:"anima",
    appearanceJa:spec.ja, appearancePromptEn:spec.en, mustNotChange:spec.keep});
  const setId=set.referenceSet?.id ?? set.id;
  console.log("set",name,setId);
  const gen=await j("POST",`/api/reference-sets/${setId}/generate`,{templateId:TPL, batchSize:4, steps:10, cfg:1, sampler:"euler", scheduler:"simple"});
  out.push({name, characterId:c.id, setId});
}
await Bun.write("refsets.json", JSON.stringify(out,null,2));
console.log("started", out.length);
