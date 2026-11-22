import { useTranslation } from "react-i18next";
import { useBatch } from "./batch";

/** Progresso da ação em lote ou, com várias miniaturas selecionadas, quantas são. */
export function BatchStatus({ selected }: { selected: number }) {
  const { t } = useTranslation();
  const batch = useBatch();
  if (batch.running) {
    return (
      <div className="sidebar-batch" role="status">
        <progress value={batch.done} max={batch.total} />
        <span>{t("sidebar.batch.progress", { done: batch.done, total: batch.total })}</span>
      </div>
    );
  }
  return selected > 1 ? <div className="sidebar-count" aria-live="polite">{t("sidebar.selectedCount", { count: selected })}</div> : null;
}
