export const MAX_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface FileUploadRequest {
  files: File[];
  containsDirectories: boolean;
  key: number;
  tree?: Promise<UploadTree>;
}
export interface UploadTree { files: Array<{file:File;relativePath:string}>; directories: string[]; error?: string }

export function safeUploadPath(path: string): string {
  if (!path || path.startsWith('/') || path.split('/').some(part=>!part || part==='.' || part==='..') || /[\\\x00-\x1f\x7f]/.test(path)) throw new Error('上传路径无效');
  return path;
}

async function readUploadEntries(entries: FileSystemEntry[]): Promise<UploadTree> {
  const result: UploadTree = {files:[],directories:[]};
  let count=0;
  const visit = async (entry: FileSystemEntry, parent='', depth=0): Promise<void> => {
    if (++count>5000 || depth>64) throw new Error('单次最多上传 5000 个文件和目录，目录层级最多 64 层');
    const path=safeUploadPath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isDirectory) {
      result.directories.push(path);
      const reader=(entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const children=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));
        if (!children.length) break;
        for (const child of children) await visit(child,path,depth+1);
      }
    } else {
      const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));
      result.files.push({file,relativePath:path});
    }
  };
  try { for (const entry of entries) await visit(entry); }
  catch (error) { return {files:[],directories:[],error:error instanceof Error ? error.message : '无法读取拖入的文件夹'}; }
  return result;
}

export function isFileDrag(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files');
}

// Read the protected drag data during drop, before the browser clears it.
export function droppedFiles(transfer: DataTransfer) {
  const entries=Array.from(transfer.items ?? []).map(item=>item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry=>!!entry);
  return {
    files: Array.from(transfer.files),
    containsDirectories: entries.some(entry=>entry.isDirectory),
    ...(entries.some(entry=>entry.isDirectory) ? {tree:readUploadEntries(entries)} : {}),
  };
}
