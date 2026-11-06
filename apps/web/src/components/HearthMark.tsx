export function HearthMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path
        d="M62 206V126a66 66 0 0 1 132 0v80"
        fill="none"
        stroke="currentColor"
        strokeWidth={28}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M128 92c15 21 30 40 30 60 0 19-13 32-30 32s-30-13-30-32c0-16 10-31 23-48 1 13 6 22 15 27 2-13-1-26-8-39Z"
        fill="#F26B38"
      />
    </svg>
  );
}
