import React from 'react'
import { useLauncher } from '../store'
import Select from './Select'

/**
 * 下载源选择器：游戏本体、依赖库、整合包文件都会走这里选的源。
 * 放在下载页 / 资源页顶部，省得为了切源跑一趟设置。
 */
export default function SourcePicker({ compact = false }: { compact?: boolean }) {
  const { settings, saveSettings, toast } = useLauncher()
  const value = settings?.downloadSource ?? 'mirror'

  return (
    <label
      className="source-picker"
      title="游戏本体 / 依赖库 / 整合包文件的下载源"
    >
      <span className="muted small">下载源</span>
      <Select
        value={value}
        width={compact ? 150 : 170}
        options={[
          { value: 'mirror', label: '国内镜像（快）' },
          { value: 'official', label: 'Mojang 官方' }
        ]}
        onChange={async (next) => {
          await saveSettings({ downloadSource: next as 'mirror' | 'official' })
          toast(next === 'mirror' ? '已切到国内镜像（BMCLAPI）' : '已切到 Mojang 官方源', 'success')
        }}
      />
    </label>
  )
}
