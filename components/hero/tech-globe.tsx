export function TechGlobe() {
  return (
    <div className="hero-globe-art globe-float mx-auto w-full max-w-[540px]" aria-hidden="true">
      <div className="hero-globe-halo" />
      <div className="hero-globe-atmosphere" />
      <div className="hero-globe-depth" />
      <svg
        className="hero-globe"
        fill="none"
        viewBox="0 0 640 640"
      >
        <defs>
          <radialGradient id="globe-fill" cx="34%" cy="27%" r="76%">
            <stop offset="0" stopColor="#1a3f6e" stopOpacity="0.98" />
            <stop offset="0.55" stopColor="#0d2240" stopOpacity="0.98" />
            <stop offset="1" stopColor="#060e1d" stopOpacity="1" />
          </radialGradient>
          <radialGradient id="globe-center-glow">
            <stop offset="0" stopColor="#70baff" stopOpacity="0.36" />
            <stop offset="1" stopColor="#55a6ff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="globe-depth-shade" cx="28%" cy="23%" r="78%">
            <stop offset="0" stopColor="#68b4ff" stopOpacity="0.12" />
            <stop offset="0.58" stopColor="#0b1a2d" stopOpacity="0" />
            <stop offset="1" stopColor="#010611" stopOpacity="0.62" />
          </radialGradient>
          <linearGradient id="continent-fill" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#7bbcff" stopOpacity="0.66" />
            <stop offset="1" stopColor="#2f73da" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id="rim-light" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#b7dfff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#d9efff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#b7dfff" stopOpacity="0" />
          </linearGradient>
          <clipPath id="globe-clip">
            <circle cx="320" cy="320" r="211" />
          </clipPath>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Ambient stars */}
        <g className="globe-stars" fill="#5aa9ff" opacity="0.45">
          <circle cx="72" cy="216" r="1.2" />
          <circle cx="103" cy="148" r="1" />
          <circle cx="157" cy="96" r="1.4" />
          <circle cx="501" cy="105" r="1.2" />
          <circle cx="564" cy="177" r="1" />
          <circle cx="590" cy="368" r="1.4" />
          <circle cx="535" cy="512" r="1" />
          <circle cx="91" cy="441" r="1.2" />
          <circle cx="612" cy="262" r="0.9" />
          <circle cx="44" cy="330" r="0.9" />
        </g>

        {/* Sphere */}
        <circle cx="320" cy="320" r="216" fill="url(#globe-fill)" stroke="#33557e" strokeWidth="1.5" />
        <circle cx="250" cy="230" r="180" fill="url(#globe-center-glow)" />
        <circle cx="320" cy="320" r="215" fill="url(#globe-depth-shade)" />

        {/* Graticule + continents */}
        <g clipPath="url(#globe-clip)" opacity="0.78" stroke="#5ba9ff" strokeWidth="1">
          <g opacity="0.7">
            <ellipse cx="320" cy="320" rx="210" ry="48" />
            <ellipse cx="320" cy="320" rx="210" ry="105" />
            <ellipse cx="320" cy="320" rx="210" ry="164" />
            <ellipse cx="320" cy="320" rx="52" ry="211" />
            <ellipse cx="320" cy="320" rx="112" ry="211" />
            <ellipse cx="320" cy="320" rx="168" ry="211" />
            <path d="M109 320h422M124 239h392M124 401h392" opacity="0.6" />
          </g>

          <g fill="url(#continent-fill)" opacity="0.92" stroke="#80c4ff" strokeOpacity="0.65">
            <path d="m166 209 19-27 39-11 31 12 24 34-18 15-18 2-10 22-30-5-17-18-18 1z" />
            <path d="m259 251 23 12 12 29-9 30-13 23-15 37-22 29-16-14 8-31 15-25-2-32 11-27z" />
            <path d="m326 215 22-18 27 4 9 19-18 11-5 22-24-5-10-17z" />
            <path d="m370 239 29-15 45 8 38 25 24 32-14 19-38-4-20 14-29-11-25 8-16-27z" />
            <path d="m389 312 29 5 24 26-5 37-24 28-18 41-24 18-17-25 10-35-6-37 15-31z" />
            <path d="m465 423 30 10 21 27-21 17-36-7-19-24z" />
            <path d="m428 482 17-8 14 9-13 13-18-3z" />
          </g>

          {/* City lights */}
          <g className="globe-lights" fill="#d8efff" filter="url(#glow)">
            <circle cx="192" cy="217" r="1.8" />
            <circle cx="213" cy="232" r="1.2" />
            <circle cx="238" cy="210" r="1.4" />
            <circle cx="265" cy="263" r="1.2" />
            <circle cx="340" cy="221" r="1.6" />
            <circle cx="359" cy="238" r="1.1" />
            <circle cx="378" cy="229" r="1.7" />
            <circle cx="397" cy="246" r="1.3" />
            <circle cx="421" cy="258" r="1.8" />
            <circle cx="448" cy="274" r="1.3" />
            <circle cx="468" cy="293" r="1.5" />
            <circle cx="402" cy="323" r="1.2" />
            <circle cx="384" cy="349" r="1.4" />
            <circle cx="409" cy="378" r="1.1" />
            <circle cx="446" cy="433" r="1.4" />
            <circle cx="250" cy="354" r="1.5" />
            <circle cx="238" cy="389" r="1.2" />
            <circle cx="205" cy="250" r="1" />
            <circle cx="288" cy="286" r="1" />
            <circle cx="436" cy="300" r="1.1" />
            <circle cx="481" cy="446" r="1" />
          </g>
        </g>

        {/* Scan line */}
        <g className="globe-scan" clipPath="url(#globe-clip)">
          <path d="M112 283h418" stroke="#b5ddff" strokeOpacity="0.38" strokeWidth="1.5" />
        </g>

        {/* Routes (animated dash flow) */}
        <g className="globe-routes" clipPath="url(#globe-clip)" stroke="#8ecbff" strokeLinecap="round">
          <path className="globe-route-dash" d="M181 225Q286 182 371 226T482 270" strokeWidth="1.8" />
          <path className="globe-route-dash" d="M242 398Q317 280 399 272T472 337" strokeWidth="1.8" />
          <path className="globe-route-dash" d="M188 326Q304 360 388 321T467 247" strokeWidth="1.5" />
          <path className="globe-route-dash" d="M188 225Q240 300 242 398" strokeWidth="1.2" opacity="0.7" />
        </g>

        {/* Orbits */}
        <g className="globe-orbit" stroke="#78bdff" strokeLinecap="round">
          <ellipse cx="320" cy="320" rx="260" ry="92" opacity="0.46" strokeDasharray="3 14" strokeWidth="1.5" transform="rotate(-18 320 320)" />
          <circle cx="566" cy="240" r="3" fill="#cfe8ff" stroke="none" filter="url(#soft-glow)" />
        </g>
        <g className="globe-orbit-reverse" stroke="#78bdff" strokeLinecap="round">
          <ellipse cx="320" cy="320" rx="236" ry="176" opacity="0.28" strokeDasharray="1 18" strokeWidth="1" transform="rotate(28 320 320)" />
          <circle cx="112" cy="430" r="2.2" fill="#9fd2ff" stroke="none" filter="url(#soft-glow)" />
        </g>

        {/* Hubs with pulse */}
        <g filter="url(#glow)">
          <circle className="globe-pulse" cx="188" cy="225" r="12" stroke="#55a6ff" strokeOpacity="0.6" />
          <circle className="globe-pulse globe-pulse-delay" cx="399" cy="272" r="13" stroke="#55a6ff" strokeOpacity="0.55" />
          <circle className="globe-pulse" cx="467" cy="247" r="11" stroke="#55a6ff" strokeOpacity="0.5" style={{ animationDelay: "0.7s" }} />
        </g>
        <g className="globe-nodes" filter="url(#glow)">
          <circle cx="188" cy="225" r="5" fill="#b9e1ff" />
          <circle cx="188" cy="225" r="12" stroke="#55a6ff" strokeOpacity="0.48" />
          <circle cx="371" cy="226" r="4" fill="#b9e1ff" />
          <circle cx="399" cy="272" r="6" fill="#55a6ff" />
          <circle cx="399" cy="272" r="13" stroke="#55a6ff" strokeOpacity="0.4" />
          <circle cx="242" cy="398" r="4" fill="#b9e1ff" />
          <circle cx="467" cy="247" r="5" fill="#55a6ff" />
          <circle cx="467" cy="247" r="11" stroke="#55a6ff" strokeOpacity="0.4" />
          <circle cx="188" cy="326" r="3" fill="#b9e1ff" />
        </g>

        {/* Rim */}
        <circle cx="320" cy="320" r="216" stroke="#82c5ff" strokeOpacity="0.32" strokeWidth="1" />
        <circle cx="320" cy="320" r="226" stroke="#55a6ff" strokeOpacity="0.12" strokeWidth="1" />
        <path
          d="M179 158A216 216 0 0 1 498 192"
          filter="url(#glow)"
          stroke="url(#rim-light)"
          strokeLinecap="round"
          strokeWidth="2.2"
        />
      </svg>
    </div>
  );
}
