// コマの局所破綻を inpaint で修復する。親候補の生成条件は凍結される。
// usage: bun repairpanel.mjs <TASKID> <ASSETID> <W> <H> '<json array of {x,y,w,h}>' [denoise]
// 矩形は 0..1 の正規化座標。マスクは白=修復対象。
const BASE="http://127.0.0.1:5199";
const sharp=(await import("sharp")).default;
const [TID,AID,W,H,RECTS,DEN]=process.argv.slice(2);
const w=Number(W),h=Number(H);
const rects=JSON.parse(RECTS);
const svg=`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#000"/>${
  rects.map(r=>`<rect x="${Math.round(r.x*w)}" y="${Math.round(r.y*h)}" width="${Math.round(r.w*w)}" height="${Math.round(r.h*h)}" fill="#fff"/>`).join("")}</svg>`;
const png=await sharp(Buffer.from(svg)).png().toBuffer();
const res=await fetch(`${BASE}/api/script-manga-tasks/${TID}/repair`,{
  method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({assetId:AID, denoise:Number(DEN??0.55),
    inpaint:{maskDataUrl:`data:image/png;base64,${png.toString("base64")}`,
      maskedContent:"original", inpaintArea:"only_masked", onlyMaskedPadding:48, featherRadius:6}})});
console.log(res.status, res.ok?"repair queued":(await res.text()).slice(0,300));
