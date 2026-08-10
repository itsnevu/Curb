// ioredis-mock ships no types; tests only need it to satisfy the RedisLike shape.
declare module "ioredis-mock" {
  const RedisMock: new (...args: unknown[]) => unknown;
  export default RedisMock;
}
