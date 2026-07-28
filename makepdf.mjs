// ページPNGから右綴じPDFを組む。外部依存を足さず、最小限のPDFを手組みする。
const sharp=(await import("sharp")).default;
const {readFileSync,writeFileSync}=await import("node:fs");
const pages=JSON.parse(readFileSync(process.argv[2],"utf8"));
const outFile=process.argv[3];
const objs=[]; const add=(s)=>{objs.push(s); return objs.length;};
const imgIds=[]; const pageIds=[];
const jpegs=[];
for (const p of pages) {
  const {data,info}=await sharp(p.file).flatten({background:"#fff"}).jpeg({quality:90}).toBuffer({resolveWithObject:true});
  jpegs.push({data,w:info.width,h:info.height});
}
let body=""; const offsets=[]; let pos=0;
const chunks=[];
const push=(s)=>{ const b=Buffer.isBuffer(s)?s:Buffer.from(s,"latin1"); chunks.push(b); pos+=b.length; };
push("%PDF-1.4\n");
const N=jpegs.length;
// object numbering: 1=Catalog 2=Pages, then per page: content(3+3i) image(4+3i) page(5+3i)
const pageObjNums=[];
const objOffsets={};
const writeObj=(num,content,stream)=>{ objOffsets[num]=pos; push(`${num} 0 obj\n${content}\n`); if(stream){ push("stream\n"); push(stream); push("\nendstream\n"); } push("endobj\n"); };
for (let i=0;i<N;i++){
  const {data,w,h}=jpegs[i];
  const imgNum=3+i*3, cNum=4+i*3, pNum=5+i*3;
  pageObjNums.push(pNum);
  writeObj(imgNum,`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>`,data);
  const cs=`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  writeObj(cNum,`<< /Length ${cs.length} >>`,Buffer.from(cs,"latin1"));
  writeObj(pNum,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${cNum} 0 R >>`);
}
writeObj(2,`<< /Type /Pages /Count ${N} /Kids [${pageObjNums.map(n=>`${n} 0 R`).join(" ")}] >>`);
// 右綴じ: PageLayout と Direction を R2L にする
writeObj(1,`<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /Direction /R2L >> /PageLayout /TwoPageRight >>`);
const maxNum=Math.max(1,2,...pageObjNums,...Object.keys(objOffsets).map(Number));
const xref=pos;
let x=`xref\n0 ${maxNum+1}\n0000000000 65535 f \n`;
for(let n=1;n<=maxNum;n++){ x+=`${String(objOffsets[n]??0).padStart(10,"0")} 00000 n \n`; }
push(x);
push(`trailer\n<< /Size ${maxNum+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
writeFileSync(outFile, Buffer.concat(chunks));
console.log("pdf pages:",N,"->",outFile);
