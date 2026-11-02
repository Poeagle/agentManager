export async function copyConversationText(text:string) {
  if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(text);return;}
  const focused=document.activeElement;const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.top='-9999px';document.body.appendChild(area);
  try{area.select();if(!document.execCommand('copy'))throw new Error('复制失败');}finally{area.remove();if(focused instanceof HTMLElement)focused.focus({preventScroll:true});}
}
