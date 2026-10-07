import sharp from 'sharp';
import {mkdir,writeFile} from 'node:fs/promises';

const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="8" y="8" width="240" height="240" rx="58" fill="#151b21"/><rect x="42" y="48" width="172" height="160" rx="18" fill="#c8f28c"/><rect x="58" y="76" width="140" height="104" rx="10" fill="#151b21"/><path d="M108 96v64l49-32z" fill="#c8f28c"/><g fill="#151b21"><rect x="61" y="58" width="20" height="10" rx="3"/><rect x="99" y="58" width="20" height="10" rx="3"/><rect x="137" y="58" width="20" height="10" rx="3"/><rect x="175" y="58" width="20" height="10" rx="3"/><rect x="61" y="188" width="20" height="10" rx="3"/><rect x="99" y="188" width="20" height="10" rx="3"/><rect x="137" y="188" width="20" height="10" rx="3"/><rect x="175" y="188" width="20" height="10" rx="3"/></g></svg>`);
const sizes=[16,32,48,64,128,256];
const frames=await Promise.all(sizes.map(size=>sharp(svg).resize(size,size).png().toBuffer()));
const header=Buffer.alloc(6+16*frames.length);
header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
let offset=header.length;
frames.forEach((frame,index)=>{
  const entry=6+index*16,size=sizes[index];
  header[entry]=size===256?0:size;header[entry+1]=header[entry];
  header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);
  header.writeUInt32LE(frame.length,entry+8);header.writeUInt32LE(offset,entry+12);
  offset+=frame.length;
});
await mkdir('build',{recursive:true});
await writeFile('build/icon.ico',Buffer.concat([header,...frames]));
