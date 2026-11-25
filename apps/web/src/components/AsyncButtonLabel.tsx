export function AsyncButtonLabel({
  idle,
  busy,
  loading,
}: {
  idle: string;
  busy: string;
  loading: boolean;
}) {
  return (
    <span className="stable-button-label">
      <span className="label-sizer" aria-hidden="true">
        {idle}
      </span>
      <span className="label-sizer" aria-hidden="true">
        {busy}
      </span>
      <span>{loading ? busy : idle}</span>
    </span>
  );
}
