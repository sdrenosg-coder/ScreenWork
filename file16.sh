cd /opt/zipy
sudo -u zipy git fetch --all --tags
sudo -u zipy git checkout <new-tag>
sudo -u zipy npm ci
sudo -u zipy npm run migrate
sudo systemctl restart zipy-worker zipy-web
