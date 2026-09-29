// Installs the git hooks in a developer checkout. CI needs no hooks, and an
// install scoped to one workspace (npm ci from desktop/) runs the root's
// prepare script without installing the root's husky.
if (process.env.CI === 'true') process.exit(0)
try {
  const { default: husky } = await import('husky')
  const out = husky()
  if (out) console.log(out)
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
  console.log('husky is not installed here; git hooks left as they are')
}
