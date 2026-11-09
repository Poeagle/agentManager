import {userInfo} from 'os';
import {join} from 'path';

/** Platform uploads run as the service OS user, independently of the selected
 * Codex account or the platform login. Tell the administrator which boundary
 * needs repair instead of returning a raw filesystem exception. */
export function pasteUploadError(kind:'image'|'file',projectPath:string,error:unknown):string {
  const failure=error as NodeJS.ErrnoException;
  const item=kind==='image'?'图片':'文件';
  if(failure?.code==='EACCES'||failure?.code==='EPERM') {
    let username=String(process.getuid?.()??'未知');
    try {username=userInfo().username;} catch {/* The numeric UID still identifies the service. */}
    return `${item}保存失败：平台运行用户 ${username} 无法写入项目附件目录 ${join(projectPath,'.agentmanager','pastes')}。请管理员为该系统用户授予目录读写权限；选择其他 Codex 账号不会改变上传进程的身份。`;
  }
  if(failure?.code==='EROFS')return `${item}保存失败：项目所在文件系统为只读，无法写入附件。`;
  if(failure?.code==='ENOSPC'||failure?.code==='EDQUOT')return `${item}保存失败：附件所在磁盘空间或用户磁盘配额不足，请清理后重试。`;
  return `Failed to save ${kind}: ${failure?.message||'unknown error'}`;
}
