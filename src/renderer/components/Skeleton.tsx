import React from 'react'

/** 骨架屏：数据没回来时先把「框」占住，回来自动覆盖，不会一片空白/一上来就报错 */
export function SkeletonLine({ width = '100%', height = 12 }: { width?: number | string; height?: number }) {
  return <span className="sk-line" style={{ width, height }} />
}

export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div className="card resource sk-card" key={i} style={{ animationDelay: `${i * 60}ms` }}>
          <div className="sk-head">
            <span className="sk-avatar" />
            <div style={{ flex: 1 }}>
              <SkeletonLine width="45%" height={14} />
              <span style={{ display: 'block', height: 6 }} />
              <SkeletonLine width="30%" height={10} />
            </div>
          </div>
          <span style={{ display: 'block', height: 10 }} />
          <SkeletonLine width="92%" height={10} />
          <span style={{ display: 'block', height: 6 }} />
          <SkeletonLine width="70%" height={10} />
          <div className="sk-actions">
            <span className="sk-pill" />
            <span className="sk-pill" />
          </div>
        </div>
      ))}
    </>
  )
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div className="sk-row" key={i} style={{ animationDelay: `${i * 50}ms` }}>
          <SkeletonLine width={`${60 + ((i * 13) % 30)}%`} height={11} />
        </div>
      ))}
    </>
  )
}
