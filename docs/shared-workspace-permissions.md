# 两个系统用户共享工作区

平台上传附件时使用平台服务的系统用户，而 Codex 执行工具时使用所选账号的系统用户。
切换平台登录用户或 Codex 账号不会自动修改项目目录的 Unix 权限。

本机共享范围为 `/home/xlli/ymchen`。使用命名访问 ACL，让 xlli、ymchen 获得与文件所有者一致的访问权限：
可写文件共同读写，Git 对象等明确只读的文件保持共同只读；目录共同读写、进入。
目录设置默认 ACL，让常规新文件继承访问权限。
不改变所有者，不把普通文档或图片设成可执行文件，也不跟随软链接更改目录外的文件。
硬链接共用 inode 和访问权限，因此按 inode 备份、修改一次。

只读检查（返回非零表示仍有权限不满足的条目）：

```bash
python3 scripts/share-workspace-access.py
```

应用权限；通常需由文件所有者或 root 运行。每项修改前记录原 ACL，备份只包含权限元数据：

```bash
python3 scripts/share-workspace-access.py --apply
```

若有非当前用户拥有且尚未共享的文件，需要管理员使用 sudo。备份位置为执行者家目录下的
`.local/state/octoally-permission-backups/`。恢复时使用脚本输出的具体备份目录：

```bash
python3 scripts/share-workspace-access.py --restore /path/to/backup
```

恢复只修改仍是原 inode 的条目，不覆盖后来替换的文件。新建文件不会被删除。应用或恢复
出现权限或文件变化错误时会报告，不声称全部成功。

程序显式创建/改成 `0600`、`0700`，或从目录外移动文件进来，仍可能覆盖继承权限；此后应重新检查。
检查会比较两个用户的有效权限，不把正常的只读 Git 对象当成未共享。
不要用给整个目录树设置 `777` 的方式替代共享用户授权。

回归测试使用临时目录及虚拟数值 UID，不依赖真实账号或生产路径：

```bash
python3 scripts/tests/share-workspace-access.test.py
npm --prefix server test -- --run tests/session-paste-upload.test.ts tests/conversation-attachments.test.ts
```
