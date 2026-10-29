import Link from 'next/link'

export default function NotFound() {
  return (
    <section className="page">
      <h1>页面不存在</h1>
      <p>你访问的地址没有对应的页面，可能已经下线或者链接写错了。</p>
      <Link className="btn-primary" href="/">
        回到赛事投注
      </Link>
    </section>
  )
}
