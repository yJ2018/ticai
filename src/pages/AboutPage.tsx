import { useState } from 'react'

export function AboutPage() {
  const [notes, setNotes] = useState('')

  return (
    <section className="page">
      <h2>关于页（缓存）</h2>
      <p>这里也启用了缓存，输入后切走再回来不会丢失。</p>
      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="写点备注试试缓存效果"
        rows={5}
      />
    </section>
  )
}
