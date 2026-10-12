export function join(...parts) {
  return parts.join('/').replace(/\/+/g, '/');
}
export default { join };
