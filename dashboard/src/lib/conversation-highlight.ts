import {classHighlighter,highlightTree} from '@lezer/highlight';
export interface CodeToken {from:number;to:number;className:string}
type Parser={parse:(source:string)=>Parameters<typeof highlightTree>[0]};
const cache=new Map<string,Promise<Parser|null>>();
async function parser(language:string):Promise<Parser|null> {
  switch(language){
    case 'js':case 'javascript':case 'jsx':case 'ts':case 'typescript':case 'tsx': {
      const grammar=await import('@codemirror/lang-javascript');return (language==='tsx'?grammar.tsxLanguage:language==='ts'||language==='typescript'?grammar.typescriptLanguage:language==='jsx'?grammar.jsxLanguage:grammar.javascriptLanguage).parser;
    }
    case 'json':case 'jsonc':return (await import('@codemirror/lang-json')).jsonLanguage.parser;
    case 'py':case 'python':return (await import('@codemirror/lang-python')).pythonLanguage.parser;
    case 'css':return (await import('@codemirror/lang-css')).cssLanguage.parser;
    case 'html':case 'xml':return (await import('@codemirror/lang-html')).htmlLanguage.parser;
    case 'c':case 'cpp':case 'c++':return (await import('@codemirror/lang-cpp')).cppLanguage.parser;
    case 'rust':case 'rs':return (await import('@codemirror/lang-rust')).rustLanguage.parser;
    case 'java':return (await import('@codemirror/lang-java')).javaLanguage.parser;
    default:return null;
  }
}
export async function highlightConversationCode(source:string,language:string):Promise<CodeToken[]> {
  if(source.length>100000)return [];
  const key=language.toLowerCase();let grammar=cache.get(key);if(!grammar){grammar=parser(key).catch(()=>null);cache.set(key,grammar);}
  const loaded=await grammar;if(!loaded)return [];
  const tokens:CodeToken[]=[];
  highlightTree(loaded.parse(source),classHighlighter,(from,to,className)=>tokens.push({from,to,className}));
  return tokens;
}
