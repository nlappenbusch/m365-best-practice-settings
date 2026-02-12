// Domain Management
function initializeDomains() {
    renderDomains();

    document.getElementById('addDomainBtn').addEventListener('click', () => {
        const domain = prompt('Domain hinzufügen:', 'example.com');
        if (domain && domain.trim()) {
            config.global.domains.push(domain.trim());
            renderDomains();
        }
    });
}

function renderDomains() {
    const container = document.getElementById('domainsList');
    container.innerHTML = '';

    config.global.domains.forEach((domain, index) => {
        const domainItem = document.createElement('div');
        domainItem.style.cssText = 'display:flex;align-items:center;gap:0.5rem;background:var(--bg-secondary);padding:0.5rem;border-radius:var(--radius-sm)';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = domain;
        input.style.cssText = 'flex:1;padding:0.5rem;border:2px solid var(--border-color);border-radius:var(--radius-sm);font-size:0.875rem';
        input.addEventListener('input', (e) => {
            config.global.domains[index] = e.target.value;
        });

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '×';
        removeBtn.className = 'btn btn-secondary';
        removeBtn.style.cssText = 'padding:0.5rem 0.75rem;font-size:1.2rem;line-height:1;min-width:auto';
        removeBtn.addEventListener('click', () => {
            config.global.domains.splice(index, 1);
            renderDomains();
        });

        domainItem.appendChild(input);
        if (config.global.domains.length > 1) {
            domainItem.appendChild(removeBtn);
        }
        container.appendChild(domainItem);
    });
}
