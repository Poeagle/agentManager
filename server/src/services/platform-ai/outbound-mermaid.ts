import {fileURLToPath} from 'node:url';
import type {Mermaid} from 'mermaid';
import {MAX_IMAGE_BYTES} from './attachments.js';

export const MAX_MERMAID_CHARS=12000;
const RENDER_TIMEOUT_MS=10000;
const MAX_SIDE=1800;
const ORIGIN='https://octoally-diagram.invalid';
const PAGE='<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}svg{display:block}</style><script src="/mermaid.js"></script>';
const POLICY="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export async function renderOutboundMermaid(source:string):Promise<Buffer> {
  if(!source.trim()||source.length>MAX_MERMAID_CHARS)throw new Error('Diagram exceeds the source limit');
  // Keep document directives from overriding the service's rendering policy.
  const diagram=source.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\s*\r?\n/,'').replace(/%%\{[\s\S]*?\}%%/g,'');
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({
    chromiumSandbox:true,timeout:RENDER_TIMEOUT_MS,
    env:{PATH:process.env.PATH,LANG:process.env.LANG},
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const render=async()=>{
      const page=await browser.newPage({
        viewport:{width:MAX_SIDE+16,height:MAX_SIDE+16},deviceScaleFactor:2,offline:true,serviceWorkers:'block',
      });
      await page.route('**/*',async route=>{
        const url=route.request().url();
        if(url===ORIGIN+'/')return route.fulfill({contentType:'text/html',headers:{'content-security-policy':POLICY},body:PAGE});
        if(url===ORIGIN+'/mermaid.js')return route.fulfill({contentType:'text/javascript',path:fileURLToPath(import.meta.resolve('mermaid/dist/mermaid.min.js'))});
        return route.abort();
      });
      await page.goto(ORIGIN);
      await page.evaluate(async({diagram,maxSide,maxSource})=>{
        const {mermaid}=window as Window&{mermaid?:Mermaid};
        if(!mermaid)throw new Error('Diagram renderer did not load');
        mermaid.initialize({
          startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,
          maxTextSize:maxSource,maxEdges:150,htmlLabels:false,flowchart:{htmlLabels:false},
          fontFamily:'Arial, sans-serif',
        });
        const {svg}=await mermaid.render('outbound-diagram',diagram);
        if(svg.length>1024*1024)throw new Error('Diagram markup exceeds the output limit');
        const element=new DOMParser().parseFromString(svg,'image/svg+xml').documentElement as unknown as SVGSVGElement;
        const [, ,width,height]=(element.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
        if(element.localName!=='svg'||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('Invalid diagram dimensions');
        const scale=Math.min(1,maxSide/Math.max(width,height));
        element.style.width=Math.ceil(width*scale)+'px';
        element.style.height=Math.ceil(height*scale)+'px';
        element.style.maxWidth='none';
        element.style.maxHeight='none';
        element.style.margin='8px';
        const frame=document.createElement('div');
        frame.id='diagram';
        frame.style.display='inline-block';
        frame.append(element);
        document.body.replaceChildren(frame);
        await document.fonts.ready;
      },{diagram,maxSide:MAX_SIDE,maxSource:MAX_MERMAID_CHARS});
      const png=await page.locator('#diagram').screenshot({animations:'disabled'});
      if(png.length>MAX_IMAGE_BYTES)throw new Error('Diagram image exceeds the output limit');
      return png;
    };
    const deadline=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Diagram rendering timed out')),RENDER_TIMEOUT_MS);
    });
    return await Promise.race([render(),deadline]);
  }finally{
    clearTimeout(timer);
    await browser.close();
  }
}
