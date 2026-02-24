export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      width="40"
      height="40"
    >
      <defs>
        <linearGradient id="logo-gradient" x1="0" y1="40" x2="40" y2="0">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      
      {/* Background shape: Modern rounded square with dynamic corner */}
      <rect
        x="4"
        y="4"
        width="32"
        height="32"
        rx="8"
        fill="url(#logo-gradient)"
        opacity="0.1"
      />
      
      {/* Lusk "L" mark: Stylized as a play button / fast forward shape */}
      {/* Vertical bar */}
      <path
        d="M12 10C12 8.89543 12.8954 8 14 8H16C17.1046 8 18 8.89543 18 10V28C18 29.1046 17.1046 30 16 30H14C12.8954 30 12 29.1046 12 28V10Z"
        fill="url(#logo-gradient)"
      />
      
      {/* Horizontal / Play arrow part */}
      <path
        d="M18 24H26.5C28.5 24 29.5 25 29.5 27C29.5 29 28.5 30 26.5 30H18V24Z"
        fill="url(#logo-gradient)"
      />
      
      {/* Viral spark / Play triangle accent */}
      <path
        d="M22 14L28 18L22 22V14Z"
        fill="url(#logo-gradient)"
        opacity="0.8"
      />
    </svg>
  );
}
