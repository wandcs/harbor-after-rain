export default async function* report(events) {
  for await (const event of events) {
    if (['test:pass', 'test:fail', 'test:summary'].includes(event.type)) {
      yield (
        JSON.stringify(event, (_key, value) =>
          value instanceof Error
            ? { ...value, name: value.name, message: value.message, stack: value.stack }
            : value,
        ) + '\n'
      );
    }
  }
}
