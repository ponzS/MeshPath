import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import VueRouter from 'unplugin-vue-router/vite'
import { VueRouterAutoImports } from 'unplugin-vue-router'
import { VitePWA } from 'vite-plugin-pwa'
// import Pages from 'vite-plugin-pages' // 移除，使用 unplugin-vue-router 代替

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Vue Router 自动路由
    VueRouter({
      routesFolder: 'src/pages',
      dts: 'src/typed-router.d.ts',
      exclude: ['**/components/**'],
    }),

    // Vue 插件
    vue(),
    // Vue 开发工具
    vueDevTools(),

    // 页面自动路由已由 unplugin-vue-router 处理

    // 自动导入 API
    AutoImport({
      imports: [
        'vue',
        'pinia',
        '@vueuse/core',
        VueRouterAutoImports,
        {
          // 自定义导入
          'vue-router/auto': ['useRoute', 'useRouter'],
        },
      ],
      dts: 'src/auto-imports.d.ts',
      dirs: [
        'src/composables',
        'src/stores',
        'src/utils',
      ],
      vueTemplate: true,
    }),

    // 自动导入组件
    Components({
      dirs: [
        'src/components',
      ],
      dts: 'src/components.d.ts',
      resolvers: [
        // Inspira UI 组件解析器
        (componentName) => {
          if (componentName.startsWith('Base')) {
            return {
              name: componentName,
              from: '@/components/ui',
            }
          }
        },
        // Heroicons 解析器
        (componentName) => {
          if (componentName.endsWith('Icon')) {
            return {
              name: componentName,
              from: '@heroicons/vue/24/outline',
            }
          }
        },
      ],
    }),

    // PWA 支持
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
           {
             urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
             handler: 'CacheFirst',
             options: {
               cacheName: 'google-fonts-cache',
               expiration: {
                 maxEntries: 10,
                 maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
               }
             }
           },
           {
             urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
             handler: 'CacheFirst',
             options: {
               cacheName: 'gstatic-fonts-cache',
               expiration: {
                 maxEntries: 10,
                 maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
               }
             }
           }
         ]
      },
      manifest: {
        name: 'PONZS',
        short_name: 'PONZS',
        description: 'Personal portfolio and blog',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    }),
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // 开发服务器配置
  server: {
    port: 3000,
    open: true,
    host: true,
    proxy: {
      '/ice': {
        target: 'http://localhost:8765',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:8765',
        ws: true,
        changeOrigin: true,
      },
    },
  },

  // 构建配置
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
    rollupOptions: {
      output: {
        // 代码分割
        manualChunks: {
          // 将 Vue 相关库分离
          vue: ['vue', 'vue-router'],
          // 将第三方库分离
          vendor: ['pinia', '@vueuse/core'],
          // 将 Gun.js 相关分离
          gun: ['gun', 'gun-avatar'],
        },
        // 资源文件命名
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name?.split('.') || []
          const ext = info[info.length - 1]
          if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(assetInfo.name || '')) {
            return 'assets/images/[name]-[hash].[ext]'
          }
          if (/\.(woff2?|eot|ttf|otf)$/i.test(assetInfo.name || '')) {
            return 'assets/fonts/[name]-[hash].[ext]'
          }
          if (ext === 'css') {
            return 'assets/css/[name]-[hash].[ext]'
          }
          return 'assets/[name]-[hash].[ext]'
        },
      },
    },
    // 启用 gzip 压缩
    reportCompressedSize: true,
    // 设置 chunk 大小警告限制
    chunkSizeWarningLimit: 10000,
  },

  // CSS 配置
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@import "@/styles/variables.scss";`,
      },
    },
  },




})
