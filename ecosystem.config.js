module.exports = {
  apps: [{
    name: 'furniai',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      FURNIAI_PORT: 3002,
    },
    max_memory_restart: '1G',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
  }]
}
