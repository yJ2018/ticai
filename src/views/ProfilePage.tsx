import { useState } from 'react'

export function ProfilePage() {
  const [text, setText] = useState('')

  return (
    <section className="page">
      <h2>个人页（不缓存）</h2>
      <p>该页面不缓存，离开后再回来会重置输入。</p>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="试试切走后会不会清空"
      />
    </section>
  )
}
