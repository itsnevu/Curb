// ioredis-mock tidak mengirim tipe sendiri; kita cuma butuh bentuk RedisLike di test.
declare module "ioredis-mock" {
  const RedisMock: new (...args: unknown[]) => unknown;
  export default RedisMock;
}
