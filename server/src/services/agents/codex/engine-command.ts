const shellSafe = /^[A-Za-z0-9_./:=+@%,-]+$/;

export function normalizeEngineCommand(value: unknown, fallback = 'codex'): string {
  const command = typeof value === 'string' ? value.trim() : '';
  const resolved = command || fallback;
  if (!resolved || resolved.length > 2_048 || /[\0\r\n]/.test(resolved)) {
    throw Object.assign(Error('Engine 启动命令无效'), { statusCode: 400 });
  }
  return resolved;
}

export function normalizeEngineArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string')) {
    throw Object.assign(Error('Engine 附加参数必须是字符串数组，且不能超过 64 项'), { statusCode: 400 });
  }
  return value.map(item => {
    const argument = item.trim();
    if (argument.length > 4_096 || /[\0\r\n]/.test(argument)) {
      throw Object.assign(Error('Engine 参数无效'), { statusCode: 400 });
    }
    return argument;
  }).filter(Boolean);
}

function quoteCommandPart(value: string): string {
  if (!value) return "''";
  return shellSafe.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function displayEngineCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandPart).join(' ');
}
