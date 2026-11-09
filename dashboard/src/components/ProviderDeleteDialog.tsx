import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useProviderUsage} from '../lib/use-provider-usage';
import {ConfirmModal} from './ConfirmModal';
import {ProviderUsageTable} from './ProviderUsageTable';

export function ProviderDeleteDialog({environmentId, name, message, onDelete, onCancel}: {
  environmentId: string;
  name: string;
  message: string;
  onDelete: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const usage = useProviderUsage(environmentId);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    if (working || usage.inUse || usage.isError) return;
    setWorking(true);
    setError('');
    try { await onDelete(); onCancel(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '删除失败，请刷新占用情况后重试');
      await client.invalidateQueries({queryKey: ['provider-usage', environmentId]});
    } finally { setWorking(false); }
  }
  return <ConfirmModal title={`删除 Provider · ${name}`} message={message} maxWidth={1080} cancelLabel="取消"
    confirmLabel={working ? '正在删除…' : '确认删除 Provider'} confirmDisabled={working || usage.inUse || usage.isError}
    onCancel={() => { if (!working) onCancel(); }} onConfirm={() => void remove()}>
    <ProviderUsageTable environmentId={environmentId}/>
    {usage.data && usage.inUse && <p className="agent-management-hint" role="status">还有 {usage.data.tabs.length} 个标签页占用此 Provider，请先关闭全部占用标签页。</p>}
    {error && <p role="alert" className="agent-management-error">{error}</p>}
  </ConfirmModal>;
}
