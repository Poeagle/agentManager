/** Serialize compound paste/Enter operations on the same native terminal.
 * RPC and SDK providers do not use this transport lock. */
const inputs = new Map<string, Promise<unknown>>();
export function withTerminalInput<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = inputs.get(sessionId) || Promise.resolve();
    const result = prior.catch(() => { }).then(operation);
    inputs.set(sessionId, result);
    void result.finally(() => { if (inputs.get(sessionId) === result)
        inputs.delete(sessionId); }).catch(() => { });
    return result;
}
