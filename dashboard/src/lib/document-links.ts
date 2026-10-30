/** Match the heading anchors commonly emitted in Markdown, including CJK
 * text and the numbered suffixes used for repeated headings. */
export function documentHeadingSlug(text:string) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu,'').replace(/\s/g,'-');
}

export function scrollDocumentFragment(scope:HTMLElement,fragment:string) {
  const exact=[...scope.querySelectorAll<HTMLElement>('[id]')].find(node=>node.id===fragment || node.id===`user-content-${fragment}`);
  if(exact) {exact.scrollIntoView({block:'start'});return true;}
  const counts=new Map<string,number>();
  for(const heading of scope.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const base=documentHeadingSlug(heading.textContent||'');
    const count=counts.get(base)||0;counts.set(base,count+1);
    const slug=count?`${base}-${count}`:base;
    if(slug===fragment || (heading.textContent||'').trim()===fragment) {heading.scrollIntoView({block:'start'});return true;}
  }
  return false;
}

export function followDocumentLink(source:string,scope:HTMLElement,resolveLocalPath:(source:string)=>string|null,onOpenFile:(path:string,fragment?:string)=>void) {
  let fragment:string|undefined;
  try {const hash=source.indexOf('#');if(hash>=0)fragment=decodeURIComponent(source.slice(hash+1));}catch{return;}
  if(source.startsWith('#')) {if(fragment)scrollDocumentFragment(scope,fragment);return;}
  const path=resolveLocalPath(source);
  if(path) {onOpenFile(path,fragment);return;}
  if(/^(https?:|mailto:|tel:|\/\/)/i.test(source))window.open(source,'_blank','noopener,noreferrer');
}
