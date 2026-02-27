FROM nginx:1.27-alpine

LABEL maintainer="ZhiDa AI Contributors"
LABEL description="智答 AI — 智能对话助手"

# Remove default nginx content
RUN rm -rf /usr/share/nginx/html/*

# Copy application files
COPY index.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/

# Custom nginx config for SPA and security headers
RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Cache static assets
    location ~* \.(css|js|svg|png|ico|woff2?)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Deny hidden files
    location ~ /\. {
        deny all;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
