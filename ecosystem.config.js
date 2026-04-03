// PM2 ecosystem — mahito-evo (instância paralela)
// Uso: pm2 start ecosystem.config.js
// Produção atual (mahito-bot) NÃO é gerenciada por este arquivo.

module.exports = {
  apps: [
    {
      name: 'mahito-evo',
      script: 'src/index.js',
      cwd: '/home/rebow/mahito-evo',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: '3001'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/rebow/mahito-evo/logs/pm2-error.log',
      out_file: '/home/rebow/mahito-evo/logs/pm2-out.log',
      merge_logs: true
    }
  ]
}
