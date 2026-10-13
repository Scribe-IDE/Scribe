# %% [markdown]
# Analysis notebook — produces figures for the paper.
# Cells tagged `[figure: <id>]` export to figures/<id>.pdf.

# %%
import numpy as np
import matplotlib.pyplot as plt

np.random.seed(42)
epochs = np.arange(1, 51)
train_loss = np.exp(-epochs / 12) + 0.02 * np.random.rand(50)
val_loss = np.exp(-epochs / 14) + 0.04 * np.random.rand(50) + 0.03

# nbval() sends a result to the paper; main.tex reads it back with \nbval{name}.
nbval("epochs", len(epochs))
nbval("final-loss", f"{train_loss[-1]:.3f}")

# %% [figure: fig-loss]
fig, ax = plt.subplots(figsize=(5, 3))
ax.plot(epochs, train_loss, color='#d4a556', linewidth=1.5, label='Train')
ax.plot(epochs, val_loss, color='#8a8885', linewidth=1.5, linestyle='--', label='Validation')
ax.set_xlabel('Epoch')
ax.set_ylabel('Loss')
ax.set_title('Training Loss')
ax.legend(frameon=False)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
fig.tight_layout()
