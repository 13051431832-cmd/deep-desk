import type { PermissionRequest } from "../store";
import { t } from "../i18n";

interface Props {
  permission: PermissionRequest;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export function PermissionCard({ permission, onApprove, onDeny }: Props) {
  return (
    <div class="perm-card">
      <div class="perm-card-header">
        <span class="perm-card-icon">⚠️</span>
        <span class="perm-card-title">{t("perm.title")}</span>
      </div>
      <div class="perm-card-body">
        <p>{permission.message}</p>
      </div>
      <div class="perm-card-actions">
        <button
          class="perm-btn perm-btn--approve"
          onClick={() => onApprove(permission.id)}
        >
          {t("perm.approve")}
        </button>
        <button
          class="perm-btn perm-btn--deny"
          onClick={() => onDeny(permission.id)}
        >
          {t("perm.deny")}
        </button>
      </div>
    </div>
  );
}
