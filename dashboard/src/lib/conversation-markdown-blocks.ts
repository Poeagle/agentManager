import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser=unified().use(remarkParse).use(remarkGfm);
export interface MarkdownBlock {key:number;offset:number;source:string;kind?:string}
interface PositionedBlock {type?:string;position?:{start:{offset?:number};end:{offset?:number}}}
/** Keep completed blocks stable while the final two blocks are still being
 * shaped by appended text (lists, tables and unfinished fences in particular).
 * Reference links and footnotes need document-wide context, so use one full
 * document for those rather than breaking their semantics across blocks. */
export class ConversationMarkdownBlocks {
  private previous='';private ended=false;private frontier=0;
  private frozen:MarkdownBlock[]=[];private rendered:MarkdownBlock[]=[];
  update(text:string,streaming:boolean):MarkdownBlock[] {
    if(text===this.previous && this.ended===!streaming)return this.rendered;
    if(!text.startsWith(this.previous) || this.ended && text!==this.previous){this.frontier=0;this.frozen=[];}
    this.previous=text;this.ended=!streaming;
    if(/^\s{0,3}\[[^\]]+\]:|\[[^\]]+\]\s*\[[^\]]*\]|\[\^[^\]]+\]/m.test(text)) {
      this.frontier=0;this.frozen=[];return this.rendered=[{key:0,offset:0,source:text}];
    }
    const tail=text.slice(this.frontier);
    const tree=parser.parse(tail) as {children:PositionedBlock[]};
    const stable=Math.max(0,tree.children.length-(streaming?2:0));
    const chunks:MarkdownBlock[]=[];let previousEnd=0;
    for(const block of tree.children){
      const start=block.position?.start.offset;const end=block.position?.end.offset;
      if(start===undefined||end===undefined)continue;
      chunks.push({key:this.frontier+start,offset:this.frontier+previousEnd,source:tail.slice(previousEnd,end),kind:block.type});previousEnd=end;
    }
    const newlyFrozen=chunks.slice(0,stable);const unstable=chunks.slice(stable);
    this.frozen.push(...newlyFrozen);
    const last=newlyFrozen.at(-1);if(last)this.frontier=last.offset+last.source.length;
    return this.rendered=[...this.frozen,...unstable];
  }
}
