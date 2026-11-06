import { poly } from '../util'

export function Sparkline(props: { data: number[]; w: number; h: number; stroke: string; opacity: number }) {
  const { data, w, h, stroke, opacity } = props
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={poly(data, w, h)} fill="none" stroke={stroke} strokeWidth={1} opacity={opacity} />
    </svg>
  )
}
