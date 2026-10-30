import type {Plugin} from 'unified';
interface MarkdownNode {type:string;value?:string;children?:MarkdownNode[];position?:{start:{offset?:number};end:{offset?:number}}}
/** CommonMark treats a closing quote before CJK text as a non-closing
 * delimiter. Restore the authored strong span for this narrow prose case,
 * without changing code, HTML, or explicitly escaped asterisks. */
export const conversationCjkStrong:Plugin=()=> (tree,file)=>{
  const source=String(file.value);
  function visit(parent:MarkdownNode) {
    if(!parent.children || ['code','inlineCode','html'].includes(parent.type))return;
    const children:MarkdownNode[]=[];
    for(const node of parent.children){
      if(node.type!=='text'||!node.value){visit(node);children.push(node);continue;}
      const authored=source.slice(node.position?.start.offset??0,node.position?.end.offset??0);
      if(authored.includes('\\*')){children.push(node);continue;}
      const pattern=/\*\*([^*\n]*?[\p{P}\p{S}])\*\*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;
      let end=0;let found=false;
      for(const match of node.value.matchAll(pattern)){
        found=true;const start=match.index!;if(start>end)children.push({type:'text',value:node.value.slice(end,start)});
        children.push({type:'strong',children:[{type:'text',value:match[1]}]});end=start+match[0].length;
      }
      if(!found)children.push(node);else if(end<node.value.length)children.push({type:'text',value:node.value.slice(end)});
    }
    parent.children=children;
  }
  visit(tree as MarkdownNode);
};
