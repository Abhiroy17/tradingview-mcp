import { useState, useRef, useEffect } from 'react';

export default function InfoTooltip({ text }) {
  const [show, setShow] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!show) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setShow(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [show]);

  return (
    <span className="info-tooltip-wrapper" ref={ref}>
      <button
        className="info-tooltip-btn"
        onClick={() => setShow(s => !s)}
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        aria-label="Info"
        type="button"
      >ℹ</button>
      {show && (
        <div className="info-tooltip-popup">
          {text}
        </div>
      )}
    </span>
  );
}
