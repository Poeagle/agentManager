interface Node {type:string;value?:string;children?:Node[];url?:string}

/** Link plain absolute paths and project-relative image paths. The file API enforces authorization. */
export function conversationFilePaths(options?:{relativeImages?:boolean}) {
  return (tree:Node) => {
    function visit(node:Node) {
      if(['link','image','code','inlineCode'].includes(node.type)||!node.children)return;
      node.children=node.children.flatMap(child=>{
        if(child.type!=='text'||!child.value){visit(child);return [child];}
        const source=child.value,parts:Node[]=[];
        const paths=options?.relativeImages
          ? /(?<![\p{L}\p{N}_:/@.%+-])(?:(?:file:\/\/\/|sandbox:\/|\/)[^\s<>`"'，。；：！？（）【】]+|(?:\.{1,2}\/)?(?:[\p{L}\p{N}_~.%+-]+\/)*[\p{L}\p{N}_~.%+-]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif)(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-]))/giu
          : /(?<![\w:/])(?:file:\/\/\/|sandbox:\/|\/)[^\s<>`"'，。；：！？（）【】]+/g;
        let cursor=0;
        for(const match of source.matchAll(paths)){
          const path=match[0].replace(/[.,;:!?)\]]+$/,'');
          if(!path||path.startsWith('//')||path==='/')continue;
          parts.push({type:'text',value:source.slice(cursor,match.index)},
            {type:'link',url:path,children:[{type:'text',value:path}]});
          cursor=match.index!+path.length;
        }
        return parts.length?[...parts,{type:'text',value:source.slice(cursor)}]:[child];
      });
    }
    visit(tree);
  };
}
