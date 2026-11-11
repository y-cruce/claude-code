function wire(client, queue) {
  if (client.type !== 'connected') return;
  console.debug('Channel notifications re-registered after reconnect');
  queue.push(client);
}

export function engine(getState, subscribe, queue) {
  const coordinator = { registerChannelHandler: client => wire(client, queue) };
  let previous = getState().mcp.clients;
  subscribe(() => {
    const clients = getState().mcp.clients;
    if (clients === previous) return;
    previous = clients;
  });
  return coordinator;
}
