FROM nginx:alpine

# Copy website files
COPY index.html /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/
COPY livedeploy.js /usr/share/nginx/html/
COPY styles.css /usr/share/nginx/html/
COPY domains.js /usr/share/nginx/html/
COPY robots.txt /usr/share/nginx/html/

# Cache-Busting: Platzhalter in den Asset-URLs pro Build stempeln,
# damit Browser nach jedem Deploy die neuen JS/CSS-Dateien laden.
RUN sed -i "s/__ASSET_VERSION__/$(date +%s)/g" /usr/share/nginx/html/index.html

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
