import type { PermissionRequest } from "../store";

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
        <span class="perm-card-title">Permission Required</span>
      </div>
      <div class="perm-card-body">
        <p>{permission.message}</p>
      </div>
      <div class="perm-card-actions">
        <button
          class="perm-btn perm-btn--approve"
          onClick={() => onApprove(permission.id)}
        >
          ✓ Approve
        </button>
        <button
          class="perm-btn perm-btn--deny"
          onClick={() => onDeny(permission.id)}
        >
          ✗ Deny
        </button>
      </div>
    </div>
  );
}
