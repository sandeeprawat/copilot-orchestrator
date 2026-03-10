export default async function echo({ message }) {
  return { success: true, output: `Echo: ${message}` };
}
